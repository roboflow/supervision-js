#!/usr/bin/env node
/* global fetch, process, URL, WebSocket */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const outputDir = path.join(rootDir, "benchmark/masks/results");
const chromePath =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viteBin = path.join(rootDir, "node_modules/.bin/vite");
const benchmarkPort = 5186;
const benchmarkUrl = `http://127.0.0.1:${benchmarkPort}/benchmark/masks/gpu/index.html`;
const benchmarkTimeoutMs = 180_000;

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const server = startViteServer();
  let chrome;
  let cdp;
  let tempProfileDir;

  try {
    await waitForHttp(benchmarkUrl);
    tempProfileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "supervision-js-gpu-benchmark-"),
    );
    chrome = await startChrome(tempProfileDir);
    const pageWebSocketUrl = await waitForPageWebSocketUrl(
      chrome.debuggingPort,
    );

    cdp = await createCdpClient(pageWebSocketUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const report = await waitForBenchmarkResult(cdp);

    await Promise.all([
      fs.writeFile(
        path.join(outputDir, "latest-gpu.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      ),
      fs.writeFile(path.join(outputDir, "latest-gpu.md"), renderReport(report)),
    ]);

    console.log(renderConsoleSummary(report));
  } finally {
    cdp?.close();
    chrome?.process.kill("SIGTERM");
    server.kill("SIGTERM");

    if (tempProfileDir) {
      await fs.rm(tempProfileDir, { force: true, recursive: true });
    }
  }
}

function startViteServer() {
  const server = spawn(
    viteBin,
    [
      "--config",
      "benchmark/masks/gpu/vite.config.ts",
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

async function startChrome(tempProfileDir) {
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
      benchmarkUrl,
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

async function waitForPageWebSocketUrl(port) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    const response = await fetch(`http://127.0.0.1:${port}/json`);

    if (response.ok) {
      const targets = await response.json();
      const target = targets.find(
        (item) =>
          item.type === "page" &&
          item.url?.includes("/benchmark/masks/gpu/index.html"),
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

  while (Date.now() - startedAt < benchmarkTimeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression:
        "window.__SUPERVISION_MASK_GPU_BENCHMARK_RESULT__ ? JSON.stringify(window.__SUPERVISION_MASK_GPU_BENCHMARK_RESULT__) : null",
      returnByValue: true,
    });
    const value = result.result?.value;

    if (typeof value === "string") {
      return JSON.parse(value);
    }

    await delay(500);
  }

  const status = await cdp.send("Runtime.evaluate", {
    expression: "document.querySelector('#status')?.textContent ?? null",
    returnByValue: true,
  });

  throw new Error(
    `Timed out waiting for GPU benchmark result. Last status: ${
      status.result?.value ?? "unknown"
    }`,
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
  return [
    "Mask GPU benchmark complete",
    "",
    `Renderer: ${report.environment.rendererType}`,
    `GPU finish: ${report.environment.gpuFinishSupported ? "yes" : "no"}`,
    "",
    ...report.cases.map(
      (result) =>
        `${result.caseName} threshold ${result.confidenceThreshold}: ${formatMs(
          result.timingMs.mean,
        )} mean/frame, ${formatMs(result.timingMs.p95)} p95, ${formatMs(
          result.decodeMs.mean,
        )} decode, ${formatMs(
          result.textureRenderMs.mean,
        )} texture/render, ${formatBytes(
          result.artifactBytes.mean,
        )} artifact/frame`,
    ),
  ].join("\n");
}

function renderReport(report) {
  const rows = report.cases
    .map(
      (result) =>
        `| ${result.caseName} | ${result.confidenceThreshold} | ${formatMs(
          result.timingMs.mean,
        )} | ${formatMs(result.timingMs.p95)} | ${formatMs(
          result.decodeMs.mean,
        )} | ${formatMs(result.textureRenderMs.mean)} | ${formatMs(
          result.projectedFullFixtureMs,
        )} | ${formatBytes(result.artifactBytes.mean)} |`,
    )
    .join("\n");

  return `# Mask GPU Benchmark

Generated: ${report.benchmark.generatedAt}

- Renderer: ${report.environment.rendererType}
- GPU finish supported: ${report.environment.gpuFinishSupported ? "yes" : "no"}
- User agent: ${report.environment.userAgent}
- Interpretation: RLE remains semantic cold storage; PNG ID-mask frames are
  runtime prepared artifacts measured here for browser decode, Pixi upload, and
  shader render cost.

| Case | Confidence | Mean / frame | P95 / frame | Decode mean | Texture/render mean | Projected fixture time | Artifact bytes / frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

## Decision Inputs

- Use mean and P95 frame timing to decide whether the active prepared artifact
  can render within a 30fps or 60fps frame budget.
- Use artifact bytes per frame to estimate hot prepared-window memory and
  transfer pressure.
- Prefer palette-shader paths when style changes should not rebuild per-frame
  mask artifacts.
`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMs(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}ms`;
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
