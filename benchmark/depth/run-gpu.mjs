#!/usr/bin/env node
/* global fetch, process, URL, WebSocket */

import { spawn, spawnSync } from "node:child_process";
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
  await writePreviewClips();

  const server = startViteServer();
  let browserProcess;
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

/**
 * The preview cases decode the Spring fixture's 720p preview and two resizes
 * of it, written here with the producer's encoder settings (TV range) so they
 * decode like a real preview at that size, and the codes case compares the
 * 720p preview's first second with ffmpeg's own decode of it. Without ffmpeg
 * those rows are skipped. A file older than the fixture's preview is
 * written again.
 */
async function writePreviewClips() {
  const source = path.join(
    rootDir,
    "demo/fixtures/spring_stereo_depth/sgbm/preview.mp4",
  );
  const sourceTime = (await fs.stat(source)).mtimeMs;
  const isCurrent = async (target) => {
    try {
      return (await fs.stat(target)).mtimeMs >= sourceTime;
    } catch {
      return false;
    }
  };
  const reference = path.join(outputDir, "preview-720p-luma.gray");

  if (!(await isCurrent(reference))) {
    // The luma plane exactly as decoded: no range or format conversion.
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-frames:v",
        "24",
        "-vf",
        "extractplanes=y",
        "-f",
        "rawvideo",
        reference,
      ],
      { stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.warn(
        "Could not decode the preview with ffmpeg; the codes case is skipped.",
      );
    }
  }

  const sizes = [
    ["preview-1080p.mp4", 1920, 1080],
    ["preview-4k.mp4", 3840, 2160],
  ];
  const tv = [
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
  ];

  for (const [name, width, height] of sizes) {
    const target = path.join(outputDir, name);

    if (await isCurrent(target)) continue;

    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-vf",
        `scale=${width}:${height}:flags=neighbor,format=yuv420p`,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-tune",
        "psnr",
        "-g",
        "24",
        "-keyint_min",
        "24",
        "-sc_threshold",
        "0",
        ...tv,
        "-bsf:v",
        "h264_metadata=video_full_range_flag=0",
        "-movflags",
        "+faststart",
        target,
      ],
      { stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.warn(
        `Could not write ${name} with ffmpeg; its rows are skipped.`,
      );
    }
  }
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
    "",
    ...(report.previewCodes ?? []).flatMap((codes) => [
      `Preview codes at ${codes.levels} levels: chose ${codes.chosen}, residual error ${codes.residualError}${codes.correction ? " (corrected)" : ""}`,
      ...codes.verdicts.map(
        (row) =>
          `  ${row.hardwareAcceleration}: ${row.supported ? (row.exact ? `exact over ${row.judgedCodes}` : `${row.mismatchedCodes} of ${row.judgedCodes} codes off by up to ${row.maxError} (corrected: ${row.correctedError}), ${row.lowCode}->${row.lowReadsAs}, ${row.highCode}->${row.highReadsAs}`) : "not offered"}${row.lumaPath ? ` (${row.lumaPath})` : ""}${row.error ? ` ${row.error}` : ""}`,
      ),
    ]),
    ...(report.previewClipCodes ?? []).map(
      (row) =>
        `Preview clip codes vs ffmpeg, ${row.decoder}${row.corrected ? " (corrected)" : ""}: ${row.error ?? `${row.frames} frames, ${row.mismatchedPixels} of ${row.pixels} pixels differ, max ${row.maxError}, mean ${row.meanError.toFixed(4)}; ${row.outsideRangePixels} outside TV range (${row.lumaPath})`}`,
    ),
    ...(report.previewDecode ?? []).map(
      (row) =>
        `Preview decode ${row.clip} ${row.decoder} (${row.copy} copy): ${row.framesPerSecond.toFixed(0)} fps, copy ${formatMs(row.copyMs.median)} (p95 ${formatMs(row.copyMs.p95)}), longest block ${formatMs(row.longestBlockMs)}`,
    ),
    ...(report.previewPlayback ?? []).map(
      (row) =>
        `Playback ${row.clip} ${row.rate}x${row.uploadAhead ? " ahead" : ""}: ${row.presents} presents, ${row.presentsWithoutDepth} without depth, ${row.gateHolds} holds (${row.gateAbandoned} gave up, ${row.heldMs.toFixed(0)} ms), present ${formatMs(row.presentMs.median)} p95 ${formatMs(row.presentMs.p95)}, uploads in present ${row.uploadsInPresent}, copy ${formatMs(row.copyMsPerDecodedFrame)}/frame, seek ${row.seekToPreviewMs === null ? "-" : formatMs(row.seekToPreviewMs)}`,
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
        `| ${row.resolution} | ${formatBytes(row.exactFrameBytes)} | ${formatBytes(row.previewFrameBytes)} | ${formatBytes(row.maxExactCacheBytes)}: ${row.exactCacheFrames} (${row.exactCacheFramesWithConfidence} with confidence) | ${formatBytes(row.maxPreviewCacheBytes)}: ${row.previewWindowFrames} (${row.previewLeadSeconds.toFixed(2)} s lead) | ${formatBytes(row.stillImageCpuBytes)} | ${formatBytes(row.decodeTransientBytes)} | ${formatBytes(row.gpuRingBytes)} + ${formatBytes(row.gpuLutBytes)}/colormap |`,
    )
    .join("\n");

  const codesRows = (report.previewCodes ?? [])
    .flatMap((codes) =>
      codes.verdicts.map(
        (row) =>
          `| ${codes.levels} | ${row.hardwareAcceleration}${row.hardwareAcceleration === codes.chosen ? " (chosen)" : ""} | ${row.supported ? "yes" : "no"} | ${row.exact === null ? "-" : row.exact ? "yes" : "no"} | ${row.mismatchedCodes ?? "-"} of ${row.judgedCodes ?? "-"} | ${row.maxError ?? "-"} | ${row.correctedError ?? "-"} | ${row.lowCode} -> ${row.lowReadsAs ?? "-"} | ${row.highCode} -> ${row.highReadsAs ?? "-"} | ${row.lumaPath ?? "-"} |`,
      ),
    )
    .join("\n");
  const clipCodesRows = (report.previewClipCodes ?? [])
    .map(
      (row) =>
        `| ${row.decoder} | ${row.corrected ? "yes" : "no"} | ${row.frames} | ${row.error ? row.error : `${row.mismatchedPixels} of ${row.pixels}`} | ${Number.isFinite(row.maxError) ? row.maxError : "-"} | ${Number.isFinite(row.meanError) ? row.meanError.toFixed(4) : "-"} | ${row.outsideRangePixels} | ${row.lumaPath ?? "-"} |`,
    )
    .join("\n");
  const previewDecodeRows = (report.previewDecode ?? [])
    .map(
      (row) =>
        `| ${row.clip} | ${row.width}x${row.height} | ${row.decoder} | ${row.copy} | ${row.frames} | ${row.framesPerSecond.toFixed(0)} | ${formatMs(row.copyMs.median)} | ${formatMs(row.copyMs.p95)} | ${formatMs(row.longestBlockMs)} | ${row.lumaPath ?? "-"} |`,
    )
    .join("\n");
  const playbackRows = (report.previewPlayback ?? [])
    .map(
      (row) =>
        `| ${row.clip} | ${row.rate}x | ${row.uploadAhead ? "ahead" : "in present"} | ${row.budgetMiB.toFixed(0)} MiB (${row.budgetLeadSeconds.toFixed(2)} s) | ${row.presents} | ${row.presentsWithoutDepth} | ${row.gateHolds} | ${row.gateAbandoned} | ${row.heldMs.toFixed(0)} ms | ${formatMs(row.presentMs.median)} | ${formatMs(row.presentMs.p95)} | ${row.uploadsInPresent} | ${formatMs(row.copyMsPerDecodedFrame)} | ${formatMs(row.longestBlockMs)} | ${row.seekToPreviewMs === null ? "-" : formatMs(row.seekToPreviewMs)} |`,
    )
    .join("\n");

  return `# Depth GPU Benchmark

Generated: ${report.benchmark.generatedAt}

- User agent: ${report.environment.userAgent}
- WebGPU: navigator.gpu ${report.environment.webGpu?.api ? "present" : "absent"}, adapter ${report.environment.webGpu?.adapter ? "granted" : "none"}
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

## 4. Preview decode

Preview codes through each decoder the page offers (the library's once-per-page
probe), then every frame of a 192-frame preview decoded back to back through
the library's reader, its luma copied in the render-preparation worker (the
session's way) or on the page (the fallback). The main-thread copy is the
page's time handing a frame over and, on the page, copying its luma out; the
longest block is the longest the main thread was busy at a stretch while
decoding. \`no-preference\` is probed at the probe's 256x256, where Chrome
picks its software decoder; at 720p and up it picks its hardware one.

| Levels | Decoder | Offered | Exact | Codes changed | Max error | After the table | Lowest code reads as | Highest code reads as | Luma path |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${codesRows}

The fixture's TV-range preview, its first second, through each decoder with
its own probe's table, against ffmpeg's luma of the same frames, both
clamped to TV range (16 to 235): a decoder that converts to RGB returns codes
the codec pushed past either end as 16 or 235, which decode to the same depth.

| Decoder | Table | Frames | Pixels that differ | Max error | Mean error | Outside TV range in ffmpeg's | Luma path |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${clipCodesRows}

| Clip | Size | Decoder | Copied in | Frames | fps | Main-thread copy median | P95 | Longest block | Luma path |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
${previewDecodeRows}

## 6. Playback with the gate, and seeking

The library's preview window plays each clip at a rate with the session's
default gate (stop below 0.1 s of wall time, resume 0.2 s later, at most 1 s
of timeline, give up after 2 s), for 4 s of wall time or the whole clip. Each
animation frame presents the frame's preview through the texture ring and
the depth shader, uploading it in the present or ahead of it. Seek is the
time from a seek to the middle of the clip, at rest, to its preview decoded.

| Clip | Rate | Upload | Budget (lead) | Presents | Without depth | Holds | Gave up | Held | Present median | P95 | Uploads in present | Copy / frame | Longest block | Seek to preview |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${playbackRows}

## 5. Memory at the default budgets (computed)

| Resolution | Exact frame | Preview frame | Exact cache | Preview window | Still image CPU | Decode transient | GPU rings (3 slots each) + LUT |
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
