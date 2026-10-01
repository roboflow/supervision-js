#!/usr/bin/env node
/* global Buffer, fetch, process, URL, WebSocket */

/**
 * Plays the depth docs playground (`?embed=depth`, the Spring stereo fixture)
 * in a headless browser and checks depth during playback: the depth drawn is
 * always the frame on screen's, the preview is drawn while playing and the
 * exact frame once paused, a seek never shows the previous frame's depth, and
 * the preview decoder never has a second instance alive. It captures
 * screenshots on the way.
 *
 *   npm run build
 *   node benchmark/depth/run-playback.mjs --screens=<dir> [--browser=firefox]
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
const pageUrl = `http://127.0.0.1:${port}/?embed=depth`;
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
  const pointAt = (x, y) => {
    const mount = document.querySelector(".depth-playground__mount");
    const canvas = mount.querySelector("canvas") ?? mount;
    const box = canvas.getBoundingClientRect();
    const init = { bubbles: true, clientX: box.left + box.width * x, clientY: box.top + box.height * y, pointerType: "mouse" };
    mount.dispatchEvent(new PointerEvent("pointermove", init));
  };
  /** Mean absolute disparity between two maps over pixels both measure. */
  const meanDifference = (a, b) => {
    const value = (map, i) => {
      const s = map.samples;
      if (s.encoding === "scaled16") return s.values[i] === 0 ? NaN : s.values[i] / s.scale;
      const code = s.values[i];
      if (code <= s.reservedMax) return NaN;
      return s.range.min + (code - s.reservedMax - 1) / (254 - s.reservedMax) * (s.range.max - s.range.min);
    };
    let sum = 0, count = 0;
    for (let i = 0; i < a.width * a.height; i += 7) {
      const d = Math.abs(value(a, i) - value(b, i));
      if (Number.isFinite(d)) { sum += d; count += 1; }
    }
    return count ? sum / count : null;
  };
  /**
   * The preview's codes against the codes the producer wrote from the exact
   * frame: a least-squares line through (written, decoded), and the mean
   * absolute code error. A decoder that squeezes full range to video range
   * shows a slope near 219/255 and an intercept near 16.
   */
  const codeFit = (preview, exact) => {
    const s = preview.samples, T = s.reservedMax, lo = s.range.min, hi = s.range.max;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, error = 0;
    for (let i = 0; i < preview.width * preview.height; i += 3) {
      const stored = exact.samples.values[i];
      if (stored === 0 || s.values[i] <= T) continue;
      const d = stored / exact.samples.scale;
      const written = Math.min(255, Math.max(T + 1, T + 1 + Math.round((d - lo) / (hi - lo) * (254 - T))));
      const decoded = s.values[i];
      n += 1; sx += written; sy += decoded; sxx += written * written; sxy += written * decoded; error += Math.abs(decoded - written);
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { meanAbsCodeError: error / n, intercept: (sy - slope * sx) / n, pixels: n, slope };
  };
  globalThis.__depthE2E = { codeFit, findSession, meanDifference, pointAt, setInput, slider, state, kept: new Map() };
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

    const file = path.join(flags.out, `latest-playback-${browserName}.json`);

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
  const started = Date.now();
  let screenshotTaken = false;
  let playingReadout = null;

  while (Date.now() - started < 4000 / rate + 1500) {
    const state = await pageState(browser);

    samples.push({ t: Date.now() - started, ...state });
    if (
      !screenshotTaken &&
      Date.now() - started > 1500 &&
      state.active?.precision === "preview"
    ) {
      await browser.evaluate(`__depthE2E.pointAt(0.43, 0.62)`);
      playingReadout = await pageState(browser);
      await browser.evaluate(`(() => {
        const active = __depthE2E.findSession().renderer.getActiveDepth();
        if (active) __depthE2E.kept.set(active.frameIndex, active.map);
      })()`);
      await screenshot(browser, `playback-${name}-playing.png`);
      screenshotTaken = true;
    }
    await sleep(50);
  }

  const playing = samples.filter(
    (sample) => sample.playbackState === "playing",
  );
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
  if (exactWhilePlaying.length > 0) {
    failures.push(`${name}: exact depth drawn while playing`);
  }
  if (playingReadout && !/preview/.test(playingReadout.readoutStatus ?? "")) {
    failures.push(
      `${name}: readout while playing says "${playingReadout.readoutStatus}"`,
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

  // The kept preview frame against the exact frames around it: the right
  // frame must be the closest, or the preview is out of step.
  const alignment = await evaluateJson(
    browser,
    `(async () => {
      const [index, preview] = [...__depthE2E.kept.entries()].at(-1) ?? [];
      if (index === undefined) return null;
      const session = __depthE2E.findSession();
      const result = { frame: index, differences: {}, codes: null };
      for (const candidate of [index - 1, index, index + 1]) {
        if (candidate < 0 || candidate >= session.frameClock.frameCount) continue;
        await session.frameNavigation.moveToFrame(candidate).catch((error) => {
          globalThis.__depthE2E.errors = [...(globalThis.__depthE2E.errors ?? []), String(error)];
        });
        const started = performance.now();
        let active = null;
        while (performance.now() - started < 5000) {
          active = session.renderer.getActiveDepth();
          if (active?.precision === "exact" && active.frameIndex === candidate) break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        const landed = active?.precision === "exact" && active.frameIndex === candidate;
        result.differences[candidate] = landed ? __depthE2E.meanDifference(preview, active.map) : null;
        if (candidate === index && landed) result.codes = __depthE2E.codeFit(preview, active.map);
      }
      __depthE2E.kept.clear();
      return result;
    })()`,
  );

  if (alignment) {
    const own = alignment.differences[alignment.frame];
    const others = Object.entries(alignment.differences)
      .filter(([frame]) => Number(frame) !== alignment.frame)
      .map(([, value]) => value);

    if (
      own === null ||
      others.some((value) => value !== null && value <= own)
    ) {
      failures.push(
        `${name}: preview frame ${alignment.frame} is not closest to its own exact frame (${JSON.stringify(alignment.differences)})`,
      );
    }
  }

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
    alignment,
    exactAfterPauseMs: exactAfterMs,
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
  const lines = [`Depth playback (${report.browser}): ${report.userAgent}`];

  for (const run of report.runs) {
    lines.push(
      `- ${run.layer} ${run.rate}x: depth in ${run.previewDrawnSamples}/${run.playingSamples} playing samples, ` +
        `readout "${run.playingReadout?.readoutStatus}" frame ${run.playingReadout?.depthFrameRow} on ${run.playingReadout?.frameOnScreen}; ` +
        `exact ${run.exactAfterPauseMs} ms after pause; seek depth after ${run.seek.depthAfterMs} ms (${run.seek.precisionFirst}), stale ${run.seek.stale}; ` +
        `buffering samples ${run.bufferingSamples}; alignment ${JSON.stringify(run.alignment?.differences ?? null)}; codes ${JSON.stringify(run.alignment?.codes ?? null)}`,
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
