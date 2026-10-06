#!/usr/bin/env node
/* global Buffer, fetch, process, URL, WebSocket */

/**
 * Plays the depth docs playground (`?embed=depth`, the Spring stereo fixture)
 * in a headless browser and checks depth during playback: the depth drawn is
 * always the frame on screen's, the depth `--playback` asks for is drawn while
 * playing (the preview for `preview`, exact frames for `exact`, either for
 * `auto`) and the exact frame once paused, a seek never shows the previous
 * frame's depth, and the preview decoder never has a second instance alive.
 * Each run reports the frames presented per second, gate holds, how often
 * exact depth played, and, on Chrome, the browser's CPU time per frame. It
 * captures screenshots on the way.
 *
 *   npm run build
 *   node benchmark/depth/run-playback.mjs --screens=<dir> [--browser=firefox]
 *     [--playback=auto|preview|exact]
 *
 * Chrome is driven over CDP and Firefox over WebDriver BiDi. The demo dev
 * server is started on `--port` (5195 by default), never on the demo's own.
 */

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
const { values: flags } = parseArgs({
  options: {
    browser: { default: "chrome", type: "string" },
    layers: { default: "sgbm,ground-truth", type: "string" },
    playback: { default: "auto", type: "string" },
    out: {
      default: path.join(rootDir, "benchmark/depth/results"),
      type: "string",
    },
    port: { default: "5195", type: "string" },
    rates: { default: "1,2", type: "string" },
    screens: { type: "string" },
  },
});
const port = Number(flags.port);
const playbackMode = flags.playback;
const pageUrl = `http://127.0.0.1:${port}/?embed=depth&depthPlayback=${playbackMode}`;
const browserName = flags.browser;
const viewport = { height: 900, width: 1440 };
const chromePath =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const firefoxPath =
  process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

/**
 * Runs before the page: counts the page's VideoDecoders, alive meaning
 * constructed and not yet closed. The engine decodes in its own worker, so the
 * ones counted here are the depth preview's and its probe's.
 */
const decoderCounter = `(() => {
  const Native = globalThis.VideoDecoder;
  if (!Native || globalThis.__depthDecoders) return;
  const stats = { created: 0, alive: 0, maxAlive: 0 };
  globalThis.__depthDecoders = stats;
  globalThis.VideoDecoder = class extends Native {
    constructor(init) {
      const error = init.error;
      super({ ...init, error: (e) => { if (!this.__closed) { this.__closed = true; stats.alive -= 1; } error(e); } });
      stats.created += 1; stats.alive += 1; stats.maxAlive = Math.max(stats.maxAlive, stats.alive);
    }
    close() { if (!this.__closed) { this.__closed = true; stats.alive -= 1; } return super.close(); }
  };
})();`;

/** Helpers the steps below call in the page. */
const pageHelpers = `(() => {
  if (globalThis.__depthE2E) return;
  const findSession = () => {
    const mount = document.querySelector(".depth-playground__mount");
    if (!mount) return null;
    const key = Object.keys(mount).find((name) => name.startsWith("__reactFiber$"));
    for (let fiber = mount[key]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
        const value = hook.memoizedState;
        if (value && typeof value === "object" && value.current && typeof value.current.setPlaybackRate === "function") return value.current;
      }
    }
    return null;
  };
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  const readoutRow = (label) => {
    for (const row of document.querySelectorAll(".depth-readout dl > div")) {
      if (row.querySelector("dt")?.textContent === label) return row.querySelector("dd")?.textContent ?? null;
    }
    return null;
  };
  const setInput = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const slider = (label) => [...document.querySelectorAll("label.docs-layer-playground__range")]
    .find((element) => element.querySelector("strong")?.textContent === label)?.querySelector("input");
  const state = () => {
    const session = findSession();
    const renderer = session?.renderer;
    const clock = session?.frameClock;
    const rendererState = renderer?.getState();
    const active = renderer?.getActiveDepth?.() ?? null;
    const presented = rendererState?.presentedTime ?? null;
    const presentedFrame = clock && presented !== null ? clock.indexAtOrBefore(presented + 0.0005) : null;
    const activeFrame = active && clock ? clock.indexAtOrBefore(active.mediaTime + 0.0005) : null;
    return {
      active: active ? { frameIndex: active.frameIndex, frameAtTime: activeFrame, precision: active.precision, mediaTime: active.mediaTime, encoding: active.map.samples.encoding } : null,
      decoders: globalThis.__depthDecoders ?? null,
      depthFrameRow: readoutRow("Depth frame"),
      disparityRow: readoutRow("Disparity"),
      stepRow: readoutRow("Step"),
      frameOnScreen: text('output[aria-label="Frame on screen"]'),
      playbackState: rendererState?.playbackState ?? null,
      presentedFrame,
      readoutStatus: text(".depth-readout header span"),
      status: text(".depth-playground__status"),
    };
  };
  /** The depth windows' diagnostics: holds, and how exact playback fares. */
  const depthWindows = () => {
    const artifacts = findSession()?.getState().renderPreparation?.artifacts ?? [];
    return artifacts
      .filter((artifact) => artifact.kind === "depthFrame")
      .map((artifact) => ({
        gateHoldCount: artifact.gateHoldCount ?? 0,
        precision: artifact.precision ?? "preview",
        preparedAheadSeconds: artifact.preparedAheadSeconds ?? null,
      }));
  };
  const pointAt = (x, y) => {
    const mount = document.querySelector(".depth-playground__mount");
    const canvas = mount.querySelector("canvas") ?? mount;
    const box = canvas.getBoundingClientRect();
    const init = { bubbles: true, clientX: box.left + box.width * x, clientY: box.top + box.height * y, pointerType: "mouse" };
    mount.dispatchEvent(new PointerEvent("pointermove", init));
  };
  globalThis.__depthE2E = { depthWindows, findSession, pointAt, setInput, slider, state };
})();`;

async function main() {
  await fs.mkdir(flags.out, { recursive: true });
  if (flags.screens) await fs.mkdir(flags.screens, { recursive: true });

  const server = startDemoServer();
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "supervision-js-depth-playback-"),
  );
  let browser;

  try {
    await waitForHttp(pageUrl);
    browser =
      browserName === "firefox"
        ? await openFirefox(profile)
        : await openChrome(profile);
    await browser.addInitScript(`${decoderCounter}\n${pageHelpers}`);

    const report = {
      browser: browserName,
      playback: playbackMode,
      generatedAt: new Date().toISOString(),
      runs: [],
      userAgent: null,
    };

    await browser.navigate(pageUrl);
    report.userAgent = await browser.evaluate("navigator.userAgent");
    await prepare(browser);

    for (const layer of flags.layers.split(",")) {
      await selectLayer(browser, layer);
      for (const rate of flags.rates.split(",").map(Number)) {
        report.runs.push(await playThrough(browser, layer, rate));
      }
    }

    report.scrub = await scrubRapidly(browser);
    report.pageErrors = await evaluateJson(
      browser,
      "globalThis.__depthE2E.errors ?? []",
    );
    report.decoders = await evaluateJson(browser, "globalThis.__depthDecoders");

    const file = path.join(
      flags.out,
      `latest-playback-${browserName}-${playbackMode}.json`,
    );

    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(renderSummary(report));

    const failures = report.runs.flatMap((run) => run.failures);

    if (report.scrub.staleFrames > 0) {
      failures.push(`scrub showed ${report.scrub.staleFrames} stale frames`);
    }
    if ((report.decoders?.maxAlive ?? 0) > 1) {
      failures.push(
        `${report.decoders.maxAlive} page decoders alive at once (probe included)`,
      );
    }
    if (failures.length > 0) {
      process.exitCode = 1;
      console.error(`FAILED:\n- ${failures.join("\n- ")}`);
    }
  } finally {
    await browser?.close();
    await stopProcess(server);
    await fs.rm(profile, { force: true, recursive: true, maxRetries: 5 });
  }
}

async function prepare(browser) {
  await waitFor(
    browser,
    "the playground to open",
    () =>
      evaluateJson(
        browser,
        `document.querySelector(".depth-playground__status")?.textContent ?? ""`,
      ).then((status) => /Exact depth for frame/.test(status)),
    90_000,
  );
  // Blend depth over the picture, so a screenshot shows whether they line up.
  await browser.evaluate(`(() => {
    __depthE2E.setInput(__depthE2E.slider("Opacity"), 0.6);
  })()`);
  await sleep(300);
}

async function selectLayer(browser, layer) {
  await browser.evaluate(`(() => {
    const radio = document.querySelector('input[name="depth-layer"][value="${layer}"]');
    if (radio && !radio.checked) radio.click();
  })()`);
  await sleep(500);
  await waitFor(browser, `exact depth for ${layer}`, async () => {
    const state = await pageState(browser);

    return (
      state.active?.precision === "exact" &&
      state.active.frameIndex === state.presentedFrame
    );
  });
}

/**
 * Plays from frame 0 at `rate`, sampling what is drawn every 50 ms, pauses,
 * waits for the exact frame, then seeks and watches for stale depth.
 */
async function playThrough(browser, layer, rate) {
  const name = `${layer}-${rate}x`;
  const failures = [];

  await browser.evaluate(`(async () => {
    const session = __depthE2E.findSession();
    session.setPlaybackRate(${rate});
    // The engine can refuse a move it cannot settle; the sample at hand is
    // what is checked, wherever the move landed.
    await session.frameNavigation.moveToFrame(0).catch((error) => {
      globalThis.__depthE2E.errors = [...(globalThis.__depthE2E.errors ?? []), String(error)];
    });
  })()`);
  await sleep(600);
  await browser.evaluate(`__depthE2E.pointAt(0.43, 0.62)`);
  await browser.evaluate(
    `document.querySelector('button[aria-label="Play the clip"]').click()`,
  );

  const samples = [];
  const windowsBefore = await evaluateJson(
    browser,
    "__depthE2E.depthWindows()",
  );
  const cpuBefore = await browser.cpuSeconds?.();
  const started = Date.now();
  let screenshotTaken = false;
  let playingReadout = null;

  while (Date.now() - started < 4000 / rate + 1500) {
    const state = await pageState(browser);

    samples.push({ t: Date.now() - started, ...state });
    if (
      !screenshotTaken &&
      Date.now() - started > 1500 &&
      state.active &&
      state.playbackState === "playing"
    ) {
      await browser.evaluate(`__depthE2E.pointAt(0.43, 0.62)`);
      playingReadout = await pageState(browser);
      await screenshot(browser, `playback-${name}-playing.png`);
      screenshotTaken = true;
    }
    await sleep(50);
  }

  const cpuAfter = await browser.cpuSeconds?.();
  const windowsAfter = await evaluateJson(browser, "__depthE2E.depthWindows()");
  const playing = samples.filter(
    (sample) => sample.playbackState === "playing",
  );
  const presentedFrames = countPresentedFrames(samples);
  const elapsedSeconds = (samples.at(-1).t - samples[0].t) / 1000;
  const holds = (precision) =>
    (windowsAfter.find((window) => window.precision === precision)
      ?.gateHoldCount ?? 0) -
    (windowsBefore.find((window) => window.precision === precision)
      ?.gateHoldCount ?? 0);
  const drawn = playing.filter((sample) => sample.active);
  const wrongFrame = samples.filter(
    (sample) =>
      sample.active && sample.active.frameIndex !== sample.active.frameAtTime,
  );
  const exactWhilePlaying = playing.filter(
    (sample) => sample.active?.precision === "exact",
  );

  if (playing.length === 0) failures.push(`${name}: never reported playing`);
  if (drawn.length < playing.length * 0.8) {
    failures.push(
      `${name}: depth drawn in ${drawn.length} of ${playing.length} playing samples`,
    );
  }
  if (wrongFrame.length > 0) {
    failures.push(
      `${name}: ${wrongFrame.length} samples drew another frame's depth`,
    );
  }
  const previewWhilePlaying = playing.filter(
    (sample) => sample.active?.precision === "preview",
  );

  if (playbackMode === "preview" && exactWhilePlaying.length > 0) {
    failures.push(`${name}: exact depth drawn while the preview plays`);
  }
  if (playbackMode === "exact" && previewWhilePlaying.length > 0) {
    failures.push(
      `${name}: preview drawn in ${previewWhilePlaying.length} samples while exact depth plays`,
    );
  }
  const readoutPrecision = playingReadout?.active?.precision;

  if (
    playingReadout &&
    readoutPrecision &&
    !new RegExp(readoutPrecision, "i").test(playingReadout.readoutStatus ?? "")
  ) {
    failures.push(
      `${name}: readout while playing ${readoutPrecision} depth says "${playingReadout.readoutStatus}"`,
    );
  }

  await browser.evaluate(
    `document.querySelector('button[aria-label="Pause the clip"]')?.click()`,
  );

  let pausedPreview = null;
  const pauseStarted = Date.now();

  await waitFor(browser, `${name} exact after pause`, async () => {
    const state = await pageState(browser);

    if (state.active?.precision === "preview") pausedPreview ??= state;
    return (
      state.active?.precision === "exact" &&
      state.active.frameIndex === state.presentedFrame
    );
  });

  const exactAfterMs = Date.now() - pauseStarted;

  await browser.evaluate(`__depthE2E.pointAt(0.43, 0.62)`);
  await sleep(150);

  const pausedReadout = await pageState(browser);

  await screenshot(browser, `playback-${name}-paused.png`);

  // Seek far away and watch every sample until the exact frame lands.
  const target = 150;
  const seekSamples = [];

  await browser.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Frame"]');
    __depthE2E.setInput(input, ${target});
  })()`);

  const seekStarted = Date.now();

  while (Date.now() - seekStarted < 3000) {
    const state = await pageState(browser);

    seekSamples.push({ t: Date.now() - seekStarted, ...state });
    if (
      state.active?.precision === "exact" &&
      state.active.frameIndex === target
    ) {
      break;
    }
    await sleep(15);
  }

  const stale = seekSamples.filter(
    (sample) =>
      sample.active &&
      (sample.active.frameIndex !== sample.active.frameAtTime ||
        (sample.presentedFrame === target &&
          sample.active.frameIndex !== target)),
  );

  if (stale.length > 0) {
    failures.push(`${name}: ${stale.length} stale samples after the seek`);
  }

  const firstDepthAfterSeek = seekSamples.find(
    (sample) => sample.active?.frameIndex === target,
  );

  await browser.evaluate(`__depthE2E.pointAt(0.43, 0.62)`);
  await sleep(150);
  await screenshot(browser, `playback-${name}-seek.png`);

  return {
    exactAfterPauseMs: exactAfterMs,
    exactPlayingSamples: exactWhilePlaying.length,
    // One letter per playing sample: E exact, P preview, - none, with the
    // frame on screen wherever the depth drawn changes.
    precisionTrace: playing
      .map((sample, index) => {
        const letter =
          sample.active?.precision === "exact"
            ? "E"
            : sample.active
              ? "P"
              : "-";
        const previous = playing[index - 1]?.active?.precision ?? null;

        return (sample.active?.precision ?? null) === previous
          ? letter
          : `${letter}${sample.presentedFrame}`;
      })
      .join(""),
    previewPlayingSamples: previewWhilePlaying.length,
    presentedFps: presentedFrames / elapsedSeconds,
    targetFps: 24 * rate,
    gateHolds: { exact: holds("exact"), preview: holds("preview") },
    cpuMsPerFrame:
      cpuBefore === undefined || cpuAfter === undefined || presentedFrames === 0
        ? null
        : ((cpuAfter - cpuBefore) * 1000) / presentedFrames,
    failures,
    layer,
    pausedPreviewBeforeExact: pausedPreview !== null,
    pausedReadout: pick(pausedReadout),
    playingReadout: playingReadout ? pick(playingReadout) : null,
    playingSamples: playing.length,
    previewDrawnSamples: drawn.length,
    rate,
    seek: {
      depthAfterMs: firstDepthAfterSeek?.t ?? null,
      precisionFirst: firstDepthAfterSeek?.active?.precision ?? null,
      samples: seekSamples.length,
      stale: stale.length,
    },
    bufferingSamples: samples.filter(
      (sample) => sample.playbackState === "buffering",
    ).length,
    wrongFrameSamples: wrongFrame.length,
  };
}

/** Drags across the clip quickly and counts any depth drawn for another frame. */
async function scrubRapidly(browser) {
  return evaluateJson(
    browser,
    `(async () => {
      const input = document.querySelector('input[aria-label="Frame"]');
      const session = __depthE2E.findSession();
      let stale = 0, drawn = 0, samples = 0;
      for (let step = 0; step < 40; step += 1) {
        __depthE2E.setInput(input, (step * 37) % 192);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const active = session.renderer.getActiveDepth();
        samples += 1;
        if (active) {
          drawn += 1;
          const atTime = session.frameClock.indexAtOrBefore(active.mediaTime + 0.0005);
          if (active.frameIndex !== atTime) stale += 1;
        }
      }
      return { drawnSamples: drawn, samples, staleFrames: stale, decoders: globalThis.__depthDecoders ?? null };
    })()`,
  );
}

/**
 * Frames the playhead moved through while sampling, wrapping at the loop:
 * at 2x a present skips one, and those count too, since the clock passed them.
 */
function countPresentedFrames(samples) {
  let frames = 0;
  let last = null;

  for (const sample of samples) {
    const frame = sample.presentedFrame;

    if (frame === null) continue;
    if (last !== null && frame !== last) {
      frames += frame > last ? frame - last : frame + 192 - last;
    }
    last = frame;
  }

  return frames;
}

function pick(state) {
  return {
    active: state.active,
    depthFrameRow: state.depthFrameRow,
    disparityRow: state.disparityRow,
    frameOnScreen: state.frameOnScreen,
    readoutStatus: state.readoutStatus,
    status: state.status,
    stepRow: state.stepRow,
  };
}

function pageState(browser) {
  return evaluateJson(browser, "__depthE2E.state()");
}

async function evaluateJson(browser, expression) {
  const text = await browser.evaluate(
    `Promise.resolve(${expression}).then((value) => JSON.stringify(value ?? null))`,
  );

  return JSON.parse(text);
}

async function screenshot(browser, name) {
  if (!flags.screens) return;

  const prefixed =
    browserName === "chrome"
      ? name
      : name.replace(/^playback-/, `playback-${browserName}-`);

  await fs.writeFile(
    path.join(flags.screens, prefixed),
    Buffer.from(await browser.screenshot(), "base64"),
  );
}

function renderSummary(report) {
  const lines = [
    `Depth playback (${report.browser}, ${report.playback}): ${report.userAgent}`,
  ];

  for (const run of report.runs) {
    lines.push(
      `- ${run.layer} ${run.rate}x: ${run.presentedFps.toFixed(1)}/${run.targetFps} fps, exact in ${run.exactPlayingSamples} and preview in ${run.previewPlayingSamples} of ${run.playingSamples} playing samples, ` +
        `gate holds ${JSON.stringify(run.gateHolds)}, CPU ${run.cpuMsPerFrame?.toFixed(1) ?? "?"} ms/frame; ` +
        `depth in ${run.previewDrawnSamples}/${run.playingSamples} playing samples, ` +
        `readout "${run.playingReadout?.readoutStatus}" frame ${run.playingReadout?.depthFrameRow} on ${run.playingReadout?.frameOnScreen}; ` +
        `exact ${run.exactAfterPauseMs} ms after pause; seek depth after ${run.seek.depthAfterMs} ms (${run.seek.precisionFirst}), stale ${run.seek.stale}; ` +
        `buffering samples ${run.bufferingSamples}`,
    );
  }
  lines.push(
    `- scrub: ${report.scrub.drawnSamples}/${report.scrub.samples} drawn, stale ${report.scrub.staleFrames}`,
    `- page decoders: ${JSON.stringify(report.decoders)}`,
    `- page errors: ${JSON.stringify(report.pageErrors)}`,
  );

  return lines.join("\n");
}

async function waitFor(browser, label, check, timeoutMs = 20_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(50);
  }

  const state = await evaluateJson(
    browser,
    "globalThis.__depthE2E?.state() ?? null",
  ).catch(() => null);

  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
}

function startDemoServer() {
  const server = spawn(
    path.join(rootDir, "node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: path.join(rootDir, "demo"), stdio: ["ignore", "pipe", "pipe"] },
  );

  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  return server;
}

async function openChrome(profile) {
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
      `--window-size=${viewport.width},${viewport.height}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const debugUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Chrome did not open DevTools.")),
      30_000,
    );

    chrome.stderr.on("data", (chunk) => {
      const match = chunk
        .toString()
        .match(/DevTools listening on (ws:\/\/\S+)/);

      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    chrome.once("exit", (code) => reject(new Error(`Chrome exited: ${code}`)));
  });
  const debugPort = new URL(debugUrl).port;
  const targets = await (
    await fetch(`http://127.0.0.1:${debugPort}/json`)
  ).json();
  const page = targets.find((target) => target.type === "page");
  const cdp = await connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: viewport.height,
    mobile: false,
    width: viewport.width,
  });

  return {
    async addInitScript(source) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    async close() {
      cdp.close();
      await stopProcess(chrome);
    },
    /** CPU seconds Chrome and every process it started have used so far. */
    cpuSeconds: () => processTreeCpuSeconds(chrome.pid),
    async evaluate(expression) {
      const result = await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        expression,
        returnByValue: true,
      });

      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      }

      return result.result.value;
    },
    async navigate(url) {
      await cdp.send("Page.navigate", { url });
      await sleep(1500);
    },
    async screenshot() {
      return (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
    },
  };
}

async function processTreeCpuSeconds(rootPid) {
  const { execFile } = await import("node:child_process");
  const table = await new Promise((resolve, reject) =>
    execFile("ps", ["-A", "-o", "pid=,ppid=,time="], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
  const rows = table
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, time]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      seconds: time
        .split(":")
        .reduce((total, part) => total * 60 + Number(part), 0),
    }));
  const tree = new Set([rootPid]);
  let grew = true;

  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }

  return rows
    .filter((row) => tree.has(row.pid))
    .reduce((total, row) => total + row.seconds, 0);
}

async function openFirefox(profile) {
  const debugPort = 9300 + Math.floor(Math.random() * 500);

  await fs.writeFile(
    path.join(profile, "user.js"),
    [
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("remote.active-protocols", 1);',
      "",
    ].join("\n"),
  );

  const firefox = spawn(
    firefoxPath,
    [
      "--headless",
      "--no-remote",
      "--profile",
      profile,
      `--remote-debugging-port=${debugPort}`,
      `--width=${viewport.width}`,
      `--height=${viewport.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Firefox did not open WebDriver BiDi.")),
      30_000,
    );

    firefox.stderr.on("data", (chunk) => {
      if (/WebDriver BiDi listening/.test(chunk.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    firefox.once("exit", (code) =>
      reject(new Error(`Firefox exited: ${code}`)),
    );
  });

  const bidi = await connect(`ws://127.0.0.1:${debugPort}/session`);

  await bidi.send("session.new", { capabilities: {} });

  const tree = await bidi.send("browsingContext.getTree", {});
  const context = tree.contexts[0].context;

  await bidi.send("browsingContext.setViewport", { context, viewport });

  return {
    async addInitScript(source) {
      await bidi.send("script.addPreloadScript", {
        functionDeclaration: `() => { ${source} }`,
      });
    },
    async close() {
      await bidi.send("session.end", {}).catch(() => undefined);
      bidi.close();
      await stopProcess(firefox);
    },
    async evaluate(expression) {
      const result = await bidi.send("script.evaluate", {
        awaitPromise: true,
        expression,
        resultOwnership: "none",
        target: { context },
      });

      if (result.type === "exception") {
        throw new Error(
          result.exceptionDetails?.text ?? "The page threw an exception.",
        );
      }

      return deserialize(result.result);
    },
    async navigate(url) {
      await bidi.send("browsingContext.navigate", {
        context,
        url,
        wait: "complete",
      });
      await sleep(1500);
    },
    async screenshot() {
      return (await bidi.send("browsingContext.captureScreenshot", { context }))
        .data;
    },
  };
}

function deserialize(value) {
  if (!value) return undefined;
  if (value.type === "undefined" || value.type === "null") return null;

  return value.value;
}

/** A JSON-over-WebSocket client: CDP and BiDi both answer by id. */
async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);

    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(
          typeof message.error === "string"
            ? `${message.error}: ${message.message}`
            : message.error.message,
        ),
      );
    } else {
      waiter.resolve(message.result);
    }
  });

  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;

      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function waitForHttp(url) {
  const started = Date.now();

  while (Date.now() - started < 60_000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }

  throw new Error(`${url} did not come up.`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));

  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
