#!/usr/bin/env node
/* global Buffer, fetch, process, URL, WebSocket */

/**
 * Opens the depth docs playground (`?embed=depth`) in headless Chrome, with
 * the page's `VideoDecoder` made to misbehave the ways a phone's can, and
 * checks that the video comes up and plays without waiting for depth, and
 * that depth joins it: preview depth while playing wherever a decoder can
 * play the preview, exact depth at rest always. The video engine decodes in
 * its own worker, which the init script does not reach, so only the depth
 * preview's decoders and its probe's are changed.
 *
 * Scenarios, each in a fresh browser profile:
 *
 * - `baseline`: this machine's own decoders, for comparison.
 * - `android`: `prefer-software` H.264 reported unsupported, as a browser
 *   without a software H.264 decoder answers, and every decoded frame held
 *   back until `flush()`. Preview depth must still be drawn while playing.
 * - `silent`: the same, but the decoder never returns a frame and its
 *   `flush()` never settles. The clip must still play, draw exact depth at
 *   rest, and say why the preview is off.
 *
 *   npm run build && npm run build -w demo
 *   npm run preview -w demo   # or any server for demo/dist
 *   node benchmark/depth/run-android-decoders.mjs [--url=<page>] [--scenarios=baseline,android,silent] [--throttle=<kbps>] [--screens=<dir>]
 *
 * `--throttle` slows the page's network to that many kilobits a second down,
 * with 300 ms of latency, and the report lists how much of each depth file
 * and lazy chunk the page fetched, and when. `--url` defaults to
 * `vite preview`'s http://127.0.0.1:4173/?embed=depth.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "ready-timeout": { default: "30000", type: "string" },
    scenarios: { default: "baseline,android,silent", type: "string" },
    screens: { type: "string" },
    throttle: { type: "string" },
    url: { default: "http://127.0.0.1:4173/?embed=depth", type: "string" },
  },
});
const readyTimeoutMs = Number(flags["ready-timeout"]);
const viewport = { height: 915, width: 412 };
const chromePath =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const androidUserAgent =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

/**
 * Runs before the page. `prefer-software` H.264 is unsupported, as on
 * Android. `holdUntilFlush` keeps every decoded frame until `flush()`;
 * `silent` drops every frame and never settles `flush()`.
 */
const decoderEmulation = (mode) => `(() => {
  const Native = globalThis.VideoDecoder;
  if (!Native || globalThis.__androidDecoders) return;
  const mode = ${JSON.stringify(mode)};
  const stats = { mode, created: 0, configured: [], decoded: 0, flushes: 0, held: 0, released: 0 };
  globalThis.__androidDecoders = stats;
  const softwareH264 = (config) =>
    config?.hardwareAcceleration === "prefer-software" && /^(avc1|avc3)/.test(config.codec ?? "");
  class AndroidLikeDecoder extends Native {
    #held = [];
    #output;
    constructor(init) {
      let self = null;
      super({
        error: init.error,
        output: (frame) => {
          if (mode === "silent") { frame.close(); return; }
          if (self) { self.#held.push(frame); stats.held += 1; }
          else init.output(frame);
        },
      });
      self = this;
      this.#output = init.output;
      stats.created += 1;
    }
    configure(config) {
      stats.configured.push(config.hardwareAcceleration ?? "no-preference");
      if (softwareH264(config)) {
        throw new DOMException("No software H.264 decoder.", "NotSupportedError");
      }
      return super.configure(config);
    }
    decode(chunk) { stats.decoded += 1; return super.decode(chunk); }
    async flush() {
      stats.flushes += 1;
      if (mode === "silent") return new Promise(() => undefined);
      await super.flush();
      const held = this.#held.splice(0);
      stats.released += held.length;
      for (const frame of held) this.#output(frame);
    }
    reset() { for (const frame of this.#held.splice(0)) frame.close(); return super.reset(); }
    close() { for (const frame of this.#held.splice(0)) frame.close(); return super.close(); }
    static async isConfigSupported(config) {
      if (softwareH264(config)) return { config, supported: false };
      return Native.isConfigSupported(config);
    }
  }
  globalThis.VideoDecoder = AndroidLikeDecoder;
})();`;

const pageHelpers = `(() => {
  if (globalThis.__androidE2E) return;
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
  const state = () => {
    const session = findSession();
    const renderer = session?.renderer;
    const clock = session?.frameClock;
    const rendererState = renderer?.getState();
    const active = renderer?.getActiveDepth?.() ?? null;
    const presented = rendererState?.presentedTime ?? null;
    return {
      active: active ? { frameIndex: active.frameIndex, precision: active.precision } : null,
      decoders: globalThis.__androidDecoders ?? null,
      message: session?.getState().renderPreparation?.message ?? null,
      notice: text(".depth-playground__notice"),
      playbackState: rendererState?.playbackState ?? null,
      playEnabled: document.querySelector('button[aria-label="Play the clip"]')?.disabled === false,
      presentedFrame: clock && presented !== null ? clock.indexAtOrBefore(presented + 0.0005) : null,
      status: text(".depth-playground__status"),
    };
  };
  globalThis.__androidE2E = { findSession, state };
})();`;

async function main() {
  if (flags.screens) await fs.mkdir(flags.screens, { recursive: true });

  const report = { results: [], url: flags.url };
  const failures = [];

  for (const scenario of flags.scenarios.split(",")) {
    const result = await runScenario(scenario);

    report.results.push(result);
    failures.push(
      ...result.failures.map((failure) => `${scenario}: ${failure}`),
    );
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
    console.error(`FAILED:\n- ${failures.join("\n- ")}`);
  }
}

async function runScenario(scenario) {
  const mode =
    scenario === "silent"
      ? "silent"
      : scenario === "baseline"
        ? null
        : "holdUntilFlush";
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "supervision-js-depth-android-"),
  );
  const browser = await openChrome(profile);
  const failures = [];
  const result = { failures, scenario };

  try {
    await browser.addInitScript(
      mode ? `${decoderEmulation(mode)}\n${pageHelpers}` : pageHelpers,
    );

    const opened = Date.now();

    await browser.navigate(flags.url);

    // The picture is up and the transport takes a play: whatever depth does.
    const media = await poll(
      browser,
      (state) =>
        state?.presentedFrame !== null &&
        state?.presentedFrame !== undefined &&
        state.playEnabled,
      readyTimeoutMs,
    );

    result.mediaReadyAfterMs = media.ok ? Date.now() - opened : null;
    result.atMediaReady = media.state;
    if (!media.ok) {
      failures.push(
        `the video was not up within ${readyTimeoutMs} ms: ${JSON.stringify(media.state)}`,
      );
      result.network = browser.network();
      return result;
    }

    const ready = await poll(
      browser,
      (state) => /Exact depth for frame/.test(state?.status ?? ""),
      readyTimeoutMs,
    );

    result.depthReadyAfterMs = ready.ok ? Date.now() - opened : null;
    result.atDepthReady = ready.state;
    if (!ready.ok) {
      failures.push(
        `no exact depth at rest within ${readyTimeoutMs} ms: ${JSON.stringify(ready.state)}`,
      );
      result.network = browser.network();
      return result;
    }
    await screenshot(browser, `${scenario}-ready.png`);

    await browser.evaluate(
      `document.querySelector('button[aria-label="Play the clip"]').click()`,
    );

    const samples = [];
    const started = Date.now();

    while (Date.now() - started < 4000) {
      samples.push(await pageState(browser));
      await sleep(50);
    }
    await screenshot(browser, `${scenario}-playing.png`);

    const playing = samples.filter(
      (sample) => sample.playbackState === "playing",
    );
    const frames = new Set(playing.map((sample) => sample.presentedFrame));
    const preview = playing.filter(
      (sample) =>
        sample.active?.precision === "preview" &&
        sample.active.frameIndex === sample.presentedFrame,
    );

    result.playingSamples = playing.length;
    result.framesSeen = frames.size;
    result.previewSamples = preview.length;
    result.atEnd = samples.at(-1);
    if (frames.size < 24) {
      failures.push(`playback moved through only ${frames.size} frames`);
    }
    if (mode === "silent") {
      if (preview.length > 0) failures.push("drew preview depth while silent");
      if (!result.atEnd.message) failures.push("diagnostics carry no message");
      if (!result.atEnd.notice) failures.push("the page shows no notice");
    } else if (preview.length < playing.length * 0.5) {
      failures.push(
        `preview depth in ${preview.length} of ${playing.length} playing samples`,
      );
    }

    await browser.evaluate(
      `document.querySelector('button[aria-label="Pause the clip"]')?.click()`,
    );

    const rested = await poll(
      browser,
      (state) =>
        state?.active?.precision === "exact" &&
        state.active.frameIndex === state.presentedFrame,
      10_000,
    );

    result.atRest = rested.state;
    if (!rested.ok) failures.push("no exact depth after pausing");
    await screenshot(browser, `${scenario}-paused.png`);
    result.warnings = browser.warnings;
    result.network = browser.network();
  } finally {
    await browser.close();
    await fs.rm(profile, { force: true, recursive: true, maxRetries: 5 });
  }

  return result;
}

async function poll(browser, check, timeoutMs) {
  const started = Date.now();
  let state = null;

  while (Date.now() - started < timeoutMs) {
    state = await pageState(browser).catch(() => null);
    if (check(state)) return { ok: true, state };
    await sleep(100);
  }

  return { ok: false, state };
}

function pageState(browser) {
  return browser.evaluate(
    "JSON.parse(JSON.stringify(globalThis.__androidE2E?.state() ?? null))",
  );
}

async function screenshot(browser, name) {
  if (!flags.screens) return;
  await fs.writeFile(
    path.join(flags.screens, name),
    Buffer.from(await browser.screenshot(), "base64"),
  );
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
  const warnings = [];
  const requests = new Map();
  const startedAt = Date.now();
  const cdp = await connect(page.webSocketDebuggerUrl, (message) => {
    const { method, params } = message;

    if (method === "Network.requestWillBeSent") {
      requests.set(params.requestId, {
        bytes: 0,
        range: params.request.headers.Range ?? null,
        startMs: Date.now() - startedAt,
        url: params.request.url,
      });
    } else if (method === "Network.responseReceived") {
      const request = requests.get(params.requestId);

      if (request) request.status = params.response.status;
    } else if (method === "Network.dataReceived") {
      const request = requests.get(params.requestId);

      if (request) request.bytes += params.dataLength;
    } else if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      const request = requests.get(params.requestId);

      if (request) {
        request.endMs = Date.now() - startedAt;
        request.outcome =
          method === "Network.loadingFinished"
            ? "finished"
            : params.canceled
              ? "canceled"
              : params.errorText;
      }
    }
    if (
      message.method === "Runtime.consoleAPICalled" &&
      (message.params.type === "warning" || message.params.type === "error")
    ) {
      warnings.push(
        message.params.args
          .map((arg) => arg.value ?? arg.description)
          .join(" "),
      );
    }
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (flags.throttle) {
    // Kilobits a second down, a quarter of that up, and a phone's latency.
    const bytesPerSecond = (Number(flags.throttle) * 1000) / 8;

    await cdp.send("Network.emulateNetworkConditions", {
      downloadThroughput: bytesPerSecond,
      latency: 300,
      offline: false,
      uploadThroughput: bytesPerSecond / 4,
    });
  }
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: androidUserAgent,
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 2,
    height: viewport.height,
    mobile: true,
    width: viewport.width,
  });

  return {
    warnings,
    /** The depth files and lazy chunks, as the page fetched them. */
    network: () =>
      [...requests.values()].filter((request) =>
        /preview\.mp4|depth\.json|exact\/|left\.mp4|assets\/src-/.test(
          request.url,
        ),
      ),
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
    },
    async screenshot() {
      return (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
    },
  };
}

async function connect(url, onEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id === undefined) {
      onEvent(message);
      return;
    }

    const waiter = pending.get(message.id);

    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
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
