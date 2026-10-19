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
    // Page query without "?", such as backends=webgl.
    query: { default: "", type: "string" },
    // The benchmark server's port; another checkout may hold the default.
    port: { default: "5187", type: "string" },
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
const benchmarkPort = Number(flags.port);
const pagePath = "/benchmark/depth/gpu/index.html";
const benchmarkUrl = `http://127.0.0.1:${benchmarkPort}${pagePath}`;
const benchmarkTimeoutMs = 900_000;

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const server = startViteServer();
  let browserProcess;
  let tempProfileDir;

  try {
    await waitForHttp(benchmarkUrl);
    tempProfileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "supervision-js-depth-benchmark-"),
    );

    let report;
    if (browser === "firefox") {
      const resultFile = path.join(outputDir, "latest-firefox.json");

      await fs.rm(resultFile, { force: true });
      browserProcess = await startFirefox(tempProfileDir, pageQuery);
      report = await waitForResultFile(resultFile);
    } else {
      const chrome = await startChrome(tempProfileDir, pageQuery);

      browserProcess = chrome.process;
      report = await waitForBenchmarkResult(async () =>
        createCdpClient(await waitForPageWebSocketUrl(chrome.debuggingPort)),
      );
    }

    const name = browser === "firefox" ? "latest-firefox" : "latest-gpu";

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
      env: { ...process.env, DEPTH_BENCHMARK_PORT: String(benchmarkPort) },
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
async function startFirefox(tempProfileDir, query) {
  // A throwaway automation profile: no update checks or downloads, no default
  // browser prompt, no telemetry, as geckodriver's profiles set them.
  await fs.writeFile(
    path.join(tempProfileDir, "user.js"),
    [
      'user_pref("app.update.auto", false);',
      'user_pref("app.update.checkInstallTime", false);',
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      "",
    ].join("\n"),
  );

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

  const client = { closed: false };

  socket.addEventListener("close", () => {
    client.closed = true;
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(new Error("The page's DevTools socket closed."));
    }
    pending.clear();
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

  return Object.assign(client, {
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
  });
}

/**
 * The page is cross-origin isolated, so Chrome moves it to a fresh process
 * after the first load, and an evaluation can land between contexts. Such
 * errors are retried, reconnecting to the page target when its socket went
 * away with the old process.
 */
async function waitForBenchmarkResult(connect) {
  const startedAt = Date.now();
  let lastStatus = "";
  let cdp = await connect();

  const evaluate = async (expression) => {
    for (;;) {
      try {
        const result = await cdp.send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          10_000,
        );

        return result.result?.value;
      } catch (error) {
        if (Date.now() - startedAt > benchmarkTimeoutMs) throw error;
        await delay(500);
        if (cdp.closed) {
          cdp = await connect();
        }
      }
    }
  };

  try {
    while (Date.now() - startedAt < benchmarkTimeoutMs) {
      const value = await evaluate(
        "window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__ ? JSON.stringify(window.__SUPERVISION_DEPTH_GPU_BENCHMARK_RESULT__) : null",
      );

      if (typeof value === "string") {
        return JSON.parse(value);
      }

      const text =
        (await evaluate(
          "document.querySelector('#status')?.textContent ?? ''",
        )) ?? "";

      if (text !== lastStatus) {
        lastStatus = text;
        console.log(`  ${text}`);
        if (text.startsWith("Benchmark failed")) throw new Error(text);
      }

      await delay(500);
    }
  } finally {
    cdp.close();
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
    `WebGPU: navigator.gpu ${report.environment.webGpu?.api ? "present" : "absent"}, adapter ${report.environment.webGpu?.adapter ? "granted" : "none"}`,
    ...report.environment.errors.map((error) => `Note: ${error}`),
    "",
    ...report.exactness.map(
      (row) =>
        `Exactness ${row.backend} ${row.name}: ${row.pass ? "PASS" : "FAIL"} (${row.codesVerified}/${row.codesInMap} codes, ${row.mismatches} mismatches, texture width ${row.textureWidth})`,
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

  return `# Depth GPU Benchmark

Generated ${report.benchmark.generatedAt} in ${report.environment.userAgent}.

## Exactness probe

| Backend | Map | Texture width | Draws | Codes exact | Mismatches | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${exactnessRows}
`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
