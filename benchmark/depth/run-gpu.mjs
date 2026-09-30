#!/usr/bin/env node
/* global fetch, process, URL, WebSocket */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outputDir = path.join(rootDir, "benchmark/depth/results");
const { values: flags } = parseArgs({
  options: {
    // chrome (CDP, the default) or firefox (headless, reports over HTTP).
    browser: { default: "chrome", type: "string" },
    // Page query without "?", such as cases=exactness&backends=webgl.
    query: { default: "", type: "string" },
  },
});
const browser = flags.browser;
const pageQuery = flags.query;
const chromePath =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const firefoxPath =
  process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const viteBin = path.join(rootDir, "node_modules/.bin/vite");
const benchmarkPort = 5187;
const pagePath = "/benchmark/depth/gpu/index.html";
const benchmarkUrl = `http://127.0.0.1:${benchmarkPort}${pagePath}`;
const benchmarkTimeoutMs = 900_000;

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const server = startViteServer();
  let browserProcess;
  let cdp;
  let tempProfileDir;

  try {
    await waitForHttp(benchmarkUrl);
    tempProfileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "supervision-js-depth-benchmark-"),
    );

    let report;
    const loadBefore = os.loadavg();

    if (browser === "firefox") {
      const resultFile = path.join(outputDir, "latest-firefox.json");

      await fs.rm(resultFile, { force: true });
      browserProcess = startFirefox(tempProfileDir, pageQuery);
      report = await waitForResultFile(resultFile);
    } else {
      const chrome = await startChrome(tempProfileDir, pageQuery);

      browserProcess = chrome.process;
      cdp = await createCdpClient(
        await waitForPageWebSocketUrl(chrome.debuggingPort),
      );
      await cdp.send("Runtime.enable");
      report = await waitForBenchmarkResult(cdp);
    }

    const name = browser === "firefox" ? "latest-firefox" : "latest-gpu";

    // Timings mean little on a busy machine, so the report says how busy it was.
    report.runner = {
      browser,
      cpus: os.cpus().length,
      loadAverageAfter: os.loadavg().map((value) => Number(value.toFixed(1))),
      loadAverageBefore: loadBefore.map((value) => Number(value.toFixed(1))),
    };

    await Promise.all([
      fs.writeFile(
        path.join(outputDir, `${name}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      ),
      fs.writeFile(path.join(outputDir, `${name}.md`), renderReport(report)),
    ]);

    console.log(renderConsoleSummary(report));

    if (report.error) {
      throw new Error(`The benchmark page failed: ${report.error}`);
    }
    if (report.exactness.some(({ pass }) => !pass)) {
      process.exitCode = 1;
      console.error("Exactness probe FAILED: some codes did not come back.");
    }
  } finally {
    cdp?.close();
    await stopProcess(browserProcess);
    await stopProcess(server);

    if (tempProfileDir) {
      await fs.rm(tempProfileDir, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 200,
      });
    }
  }
}

/** Waits for the process to exit, so its profile directory is quiet. */
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));

  child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
}

function startViteServer() {
  const server = spawn(
    viteBin,
    [
      "--config",
      "benchmark/depth/gpu/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(benchmarkPort),
      "--strictPort",
    ],
    {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  server.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  server.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return server;
}

async function startChrome(tempProfileDir, query) {
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--enable-gpu",
      "--no-first-run",
      "--remote-debugging-port=0",
      "--use-angle=metal",
      `--user-data-dir=${tempProfileDir}`,
      `${benchmarkUrl}${query ? `?${query}` : ""}`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  const debugUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Chrome DevTools endpoint."));
    }, 30_000);

    chrome.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);

      process.stderr.write(chunk);

      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chrome.once("error", reject);
    chrome.once("exit", (code) => {
      reject(new Error(`Chrome exited before DevTools was ready: ${code}`));
    });
  });
  const debuggingPort = Number(new URL(debugUrl).port);

  return {
    debuggingPort,
    process: chrome,
  };
}

/**
 * Firefox has no CDP, so the page reports through the benchmark server
 * (`?report=firefox`) and the runner waits for the file it writes.
 */
function startFirefox(tempProfileDir, query) {
  const url = `${benchmarkUrl}?${[query, "report=firefox"].filter(Boolean).join("&")}`;
  const firefox = spawn(
    firefoxPath,
    ["--headless", "--no-remote", "--profile", tempProfileDir, url],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  firefox.stderr.on("data", (chunk) => process.stderr.write(chunk));

  return firefox;
}

async function waitForResultFile(file) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < benchmarkTimeoutMs) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      await delay(1000);
    }
  }

  throw new Error(`Timed out waiting for ${file}.`);
}

async function waitForPageWebSocketUrl(port) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    const response = await fetch(`http://127.0.0.1:${port}/json`);

    if (response.ok) {
      const targets = await response.json();
      const target = targets.find(
        (item) => item.type === "page" && item.url?.includes(pagePath),
      );

      if (target?.webSocketDebuggerUrl) {
        return target.webSocketDebuggerUrl;
      }
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for benchmark page target.");
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { reject, resolve, timeout } = pending.get(message.id);

    clearTimeout(timeout);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(message.error.message));
      return;
    }

    resolve(message.result);
  });

  return {
    close() {
      socket.close();
    },

    send(method, params = {}, timeoutMs = benchmarkTimeoutMs) {
      const id = nextId;

      nextId += 1;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for CDP method ${method}.`));
        }, timeoutMs);

        pending.set(id, { reject, resolve, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function waitForBenchmarkResult(cdp) {
  const startedAt = Date.now();
  let lastStatus = "";

  while (Date.now() - startedAt < benchmarkTimeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression:
        "window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__ ? JSON.stringify(window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__) : null",
      returnByValue: true,
    });
    const value = result.result?.value;

    if (typeof value === "string") {
      return JSON.parse(value);
    }

    const status = await cdp.send("Runtime.evaluate", {
      expression: "document.querySelector('#status')?.textContent ?? ''",
      returnByValue: true,
    });
    const text = status.result?.value ?? "";

    if (text !== lastStatus) {
      lastStatus = text;
      console.log(`  ${text}`);
      if (text.startsWith("Benchmark failed")) throw new Error(text);
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for the depth benchmark result. Last status: ${lastStatus}`,
  );
}

async function waitForHttp(url) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url, { method: "HEAD" });

      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

function renderConsoleSummary(report) {
  if (report.error) return `Depth benchmark failed: ${report.error}`;

  return [
    "Depth GPU benchmark complete",
    "",
    ...report.environment.backends.map(
      (backend) =>
        `Backend ${backend.requested} -> ${backend.rendererName} (${backend.gpu}), max texture ${backend.maxTextureSize}`,
    ),
    ...report.environment.errors.map((error) => `Note: ${error}`),
    "",
    ...report.exactness.map(
      (row) =>
        `Exactness ${row.backend} ${row.name}: ${row.pass ? "PASS" : "FAIL"} (${row.codesVerified}/${row.codesInMap} codes, ${row.mismatches} mismatches, texture width ${row.textureWidth})`,
    ),
    "",
    ...report.decode.map(
      (row) =>
        `Decode ${row.resolution} ${row.format}: ${formatMegabytes(row.bytes)}, main ${formatMs(row.mainThreadMs.median)}${row.workerRoundTripMs ? `, worker ${formatMs(row.workerRoundTripMs.median)}` : ""}${row.exact ? "" : " NOT EXACT"}`,
    ),
    "",
    ...report.uploadRender.map(
      (row) =>
        `Upload/render ${row.backend} ${row.resolution} ${row.encoding}: upload+render ${formatMs(row.uploadAndRenderMs.median)}, render ${formatMs(row.renderOnlyMs.median)}, upload share ${formatMs(row.uploadShareMs)}`,
    ),
  ].join("\n");
}

function renderReport(report) {
  if (report.error) {
    return `# Depth GPU Benchmark\n\nThe page failed: ${report.error}\n`;
  }

  const exactnessRows = report.exactness
    .map(
      (row) =>
        `| ${row.backend} | ${row.name} | ${row.textureWidth} | ${row.passes} | ${row.codesVerified} / ${row.codesInMap} | ${row.mismatches} | ${row.pass ? "pass" : "FAIL"} |`,
    )
    .join("\n");
  const decodeRows = report.decode
    .map(
      (row) =>
        `| ${row.resolution} | ${row.format} | ${row.filterCounts ? row.filterCounts.join("/") : "-"} | ${formatMegabytes(row.bytes)} | ${formatMs(row.mainThreadMs.median)} | ${formatMs(row.mainThreadMs.p95)} | ${row.workerRoundTripMs ? formatMs(row.workerRoundTripMs.median) : "-"} | ${row.workerDecodeMs ? formatMs(row.workerDecodeMs.median) : "-"} | ${row.exact ? "yes" : "NO"} |`,
    )
    .join("\n");
  const uploadRows = report.uploadRender
    .map(
      (row) =>
        `| ${row.backend} | ${row.resolution} | ${row.encoding} | ${formatBytes(row.bytesPerFrame)} | ${formatMs(row.uploadAndRenderMs.median)} | ${formatMs(row.uploadAndRenderMs.p95)} | ${formatMs(row.renderOnlyMs.median)} | ${formatMs(row.renderOnlyMs.p95)} | ${formatMs(row.uploadShareMs)} |`,
    )
    .join("\n");
  const memoryRows = report.memory
    .map(
      (row) =>
        `| ${row.resolution} | ${formatBytes(row.exactFrameBytes)} | ${formatBytes(row.previewFrameBytes)} | ${row.exactCacheFrames} (${row.exactCacheFramesWithConfidence} with confidence) | ${row.previewWindowFrames} (${row.previewLeadSeconds.toFixed(2)} s lead) | ${formatBytes(row.stillImageCpuBytes)} | ${formatBytes(row.decodeTransientBytes)} | ${formatBytes(row.gpuRingBytes)} + ${formatBytes(row.gpuLutBytes)}/colormap |`,
    )
    .join("\n");

  return `# Depth GPU Benchmark

Generated: ${report.benchmark.generatedAt}

- User agent: ${report.environment.userAgent}
- Host load average (1, 5, 15 min) before / after: ${report.runner?.loadAverageBefore?.join(", ")} / ${report.runner?.loadAverageAfter?.join(", ")} on ${report.runner?.cpus} CPUs
${report.environment.backends
  .map(
    (backend) =>
      `- ${backend.requested}: Pixi ${backend.rendererName}, ${backend.gpu}, max texture ${backend.maxTextureSize}`,
  )
  .join("\n")}
${report.environment.errors.map((error) => `- Note: ${error}`).join("\n")}
- Data: synthetic stereo scene (not model output), disparity x256 (x128 at 4K).

## 1. Exactness probe

| Backend | Map | Texture width | Draws | Codes exact | Mismatches | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${exactnessRows}

## 2. PNG16 decode per frame

Filter counts are rows written as None/Sub/Up/Average/Paeth.

| Resolution | Format | Rows by filter | Size | Main median | Main P95 | Worker round trip | Worker decode | Exact |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${decodeRows}

## 3. Upload and render per frame

Medians over 30 presents after 5 warm-ups, each waited on (WebGL: one-pixel readback;
WebGPU: \`onSubmittedWorkDone\`). The upload share is the difference of the two medians.

| Backend | Resolution | Encoding | Bytes / frame | Upload + render | P95 | Render only (uploaded ahead) | P95 | Upload share |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${uploadRows}

## 5. Memory at the proposed default budgets (computed)

| Resolution | Exact frame | Preview frame | Exact cache (128 MiB) | Preview window (96 MiB) | Still image CPU | Decode transient | GPU ring (3 slots) + LUT |
| --- | ---: | ---: | --- | --- | ---: | ---: | --- |
${memoryRows}
`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMs(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

/** Binary units (MiB), as the memory budgets are written. */
function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Decimal megabytes, as research 07 reports file sizes. */
function formatMegabytes(value) {
  return `${(value / 1e6).toFixed(2)} MB`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
