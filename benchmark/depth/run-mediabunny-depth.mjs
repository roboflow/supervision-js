#!/usr/bin/env node
/* global Buffer, fetch, process, URL, WebSocket */

/**
 * Plays the Spring stereo sample's depth clip in the demo workbench on the
 * Mediabunny media path, in headless Chrome: play, pause until exact depth,
 * seek, and drag the timeline both ways. Every animation frame it records
 * the frame on screen and the depth drawn over it, and counts the frames that
 * showed depth for another frame, which must be none. Screenshots go to
 * `--screens` as mediabunny-depth-*.png.
 *
 *   npm run build
 *   node benchmark/depth/run-mediabunny-depth.mjs --screens=<dir>
 *
 * Frames are named by the video's own packet timestamps, read here in Node
 * with Mediabunny, not by anything the page reports. The demo dev server is
 * started on `--port` (5196 by default), never on the demo's own.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { BufferSource, EncodedPacketSink, Input, MP4, QTFF } from "mediabunny";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { values: flags } = parseArgs({
  options: {
    out: {
      default: path.join(rootDir, "benchmark/depth/results"),
      type: "string",
    },
    port: { default: "5196", type: "string" },
    screens: { type: "string" },
  },
});
const port = Number(flags.port);
const pageUrl = `http://127.0.0.1:${port}/?mediaPath=mediabunny`;
const fixtureId = "spring_stereo_depth";
const videoFile = path.join(rootDir, "demo/fixtures", fixtureId, "left.mp4");
const viewport = { height: 900, width: 1440 };
const chromePath =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Records, every animation frame, what is on screen and the depth over it. */
const sampler = `(() => {
  if (globalThis.__mbDepth) return;
  let samples = null;
  const tick = () => {
    const renderer = globalThis.__demoRenderer;
    if (samples && renderer) {
      const state = renderer.getState();
      const active = renderer.getActiveDepth?.() ?? null;
      samples.push({
        at: performance.now(),
        presentedTime: state.presentedTime ?? null,
        playbackState: state.playbackState,
        depthIndex: active ? active.frameIndex : null,
        depthTime: active ? active.mediaTime : null,
        precision: active ? active.precision : null,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  globalThis.__mbDepth = {
    start() { samples = []; },
    stop() { const taken = samples ?? []; samples = null; return taken; },
  };
})();`;

async function main() {
  await fs.mkdir(flags.out, { recursive: true });
  if (flags.screens) await fs.mkdir(flags.screens, { recursive: true });

  const frameTimes = await readFrameTimes(videoFile);
  const frameAt = (time) => {
    if (time === null) return null;
    let low = 0;
    let high = frameTimes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (frameTimes[middle] <= time + 0.0005) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const server = startDemoServer();
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "supervision-js-mediabunny-depth-"),
  );
  let browser;

  try {
    await waitForHttp(pageUrl);
    browser = await openChrome(profile);
    await browser.addInitScript(sampler);
    await browser.navigate(pageUrl);
    await waitFor(browser, "the demo renderer", () =>
      browser.evaluate("Boolean(globalThis.__demoRenderer)"),
    );
    await openSpring(browser);

    const mediaPath = await browser.evaluate(
      `document.querySelector('[data-eval="shell"]')?.getAttribute("data-eval-media-path") ?? null`,
    );
    const depthSwitch = await browser.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Show depth"]') ??
        [...document.querySelectorAll("label")].find((label) => label.textContent.trim() === "Depth")?.querySelector("input");
      return input ? { checked: input.checked, disabled: input.disabled } : null;
    })()`);
    const userAgent = await browser.evaluate("navigator.userAgent");
    const duration = frameTimes.at(-1);
    const phases = [];
    const summarize = (name, samples, extra = {}) => {
      const shown = samples.filter((sample) => sample.presentedTime !== null);
      const withDepth = shown.filter((sample) => sample.depthIndex !== null);
      const wrong = withDepth.filter(
        (sample) =>
          sample.depthIndex !== frameAt(sample.presentedTime) ||
          Math.abs(sample.depthTime - sample.presentedTime) > 0.0005,
      );
      const frames = new Set(shown.map((s) => frameAt(s.presentedTime)));
      const phase = {
        name,
        samples: shown.length,
        framesShown: frames.size,
        samplesWithDepth: withDepth.length,
        preview: withDepth.filter((s) => s.precision === "preview").length,
        exact: withDepth.filter((s) => s.precision === "exact").length,
        wrongFrameDepth: wrong.length,
        wrongExamples: wrong.slice(0, 3),
        ...extra,
      };
      phases.push(phase);
      return phase;
    };

    // Play from the start for three seconds.
    await browser.evaluate(
      "(async () => { const r = globalThis.__demoRenderer; r.pause(); await r.seek(0); })()",
    );
    await waitForExact(browser, frameAt);
    await browser.evaluate("globalThis.__mbDepth.start()");
    await browser.evaluate("globalThis.__demoRenderer.play()");
    await sleep(1500);
    await screenshot(browser, "mediabunny-depth-play.png");
    await sleep(1500);
    summarize("play", await stopSamples(browser));

    // Pause: the frame on screen gets its exact depth.
    await browser.evaluate("globalThis.__mbDepth.start()");
    await browser.evaluate("globalThis.__demoRenderer.pause()");
    const pausedExactMs = await waitForExact(browser, frameAt);
    await screenshot(browser, "mediabunny-depth-paused-exact.png");
    summarize("pause", await stopSamples(browser), {
      exactAfterMs: pausedExactMs,
    });

    // Seek forward and back while paused.
    for (const target of [5.25, 1.5]) {
      await browser.evaluate("globalThis.__mbDepth.start()");
      await browser.evaluate(`globalThis.__demoRenderer.seek(${target})`);
      const exactMs = await waitForExact(browser, frameAt);
      if (target === 5.25) {
        await screenshot(browser, "mediabunny-depth-seek.png");
      }
      summarize(`seek ${target}s`, await stopSamples(browser), {
        exactAfterMs: exactMs,
        landedFrame: frameAt(
          await browser.evaluate(
            "globalThis.__demoRenderer.getState().presentedTime",
          ),
        ),
        expectedFrame: frameAt(target),
      });
    }

    // Drag the timeline forwards, then backwards, the way a thumb does.
    for (const [name, from, to] of [
      ["drag forward", 0.15, 0.85],
      ["drag backward", 0.85, 0.15],
    ]) {
      await browser.evaluate(
        `globalThis.__demoRenderer.seek(${(duration * from).toFixed(3)})`,
      );
      await waitForExact(browser, frameAt);
      const box = await browser.evaluate(`(() => {
        const input = document.querySelector('[data-eval="timeline-input"]');
        const rect = input.getBoundingClientRect();
        return { left: rect.x, width: rect.width, y: Math.round(rect.y + rect.height / 2) };
      })()`);
      const fromX = box.left + box.width * from;
      const toX = box.left + box.width * to;
      const steps = 90;

      await browser.evaluate("globalThis.__mbDepth.start()");
      await browser.mouse("mousePressed", fromX, box.y);
      const started = Date.now();
      for (let step = 1; step <= steps; step += 1) {
        await browser.mouse(
          "mouseMoved",
          fromX + ((toX - fromX) * step) / steps,
          box.y,
        );
        const owed = started + (1200 * step) / steps - Date.now();
        if (owed > 0) await sleep(owed);
        if (step === steps / 2) {
          await screenshot(
            browser,
            `mediabunny-depth-${name.replace(" ", "-")}.png`,
          );
        }
      }
      await browser.mouse("mouseReleased", toX, box.y);
      const releasedAt = Date.now();
      await waitForExact(browser, frameAt);
      const exactAfterReleaseMs = Date.now() - releasedAt;
      const samples = await stopSamples(browser);
      summarize(name, samples, { exactAfterReleaseMs });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      depthSwitch,
      frameCount: frameTimes.length,
      mediaPath,
      phases,
      userAgent,
    };
    const file = path.join(flags.out, "latest-mediabunny-depth.json");

    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(renderSummary(report));

    const failures = [];
    if (mediaPath !== "mediabunny") failures.push(`ran on ${mediaPath}`);
    if (!depthSwitch || depthSwitch.disabled) {
      failures.push(`Depth switch ${JSON.stringify(depthSwitch)}`);
    }
    for (const phase of phases) {
      if (phase.wrongFrameDepth > 0) {
        failures.push(
          `${phase.name}: ${phase.wrongFrameDepth} wrong-frame depth`,
        );
      }
      if (phase.samplesWithDepth === 0) {
        failures.push(`${phase.name}: no depth drawn`);
      }
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

async function readFrameTimes(file) {
  const input = new Input({
    formats: [MP4, QTFF],
    source: new BufferSource(await fs.readFile(file)),
  });
  const track = await input.getPrimaryVideoTrack();
  const times = [];

  for await (const packet of new EncodedPacketSink(track).packets(
    undefined,
    undefined,
    { metadataOnly: true },
  )) {
    times.push(packet.timestamp);
  }
  input.dispose();
  return times.sort((a, b) => a - b);
}

/** Selects the Spring sample in the Clip tab and waits for its session. */
async function openSpring(browser) {
  await browser.evaluate(
    `document.querySelector('[data-eval="inspector-tab:clip"]')?.click()`,
  );
  await waitFor(browser, "the Spring sample button", () =>
    browser.evaluate(
      `Boolean(document.querySelector('[data-eval="fixture:${fixtureId}"]'))`,
    ),
  );
  const pressed = await browser.evaluate(
    `document.querySelector('[data-eval="fixture:${fixtureId}"]').getAttribute("aria-pressed") === "true"`,
  );
  if (!pressed) {
    await browser.evaluate(`(() => {
      globalThis.__mbDepthMark = globalThis.__demoRenderer;
      document.querySelector('[data-eval="fixture:${fixtureId}"]').click();
    })()`);
    await waitFor(
      browser,
      "the Spring session",
      () =>
        browser.evaluate(
          "Boolean(globalThis.__demoRenderer) && globalThis.__demoRenderer !== globalThis.__mbDepthMark",
        ),
      60_000,
    );
  }
  await browser.evaluate(
    `document.querySelector('[data-eval="inspector-tab:style"]')?.click()`,
  );
  await waitFor(
    browser,
    "depth on screen",
    () =>
      browser.evaluate(
        "Boolean(globalThis.__demoRenderer?.getActiveDepth?.())",
      ),
    60_000,
  );
}

/** Waits for exact depth over the frame on screen, playback paused. */
async function waitForExact(browser, frameAt) {
  const started = Date.now();

  await waitFor(
    browser,
    "exact depth over the frame on screen",
    async () => {
      const state = JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const r = globalThis.__demoRenderer;
          const s = r.getState();
          if (s.playbackState === "playing") r.pause();
          const a = r.getActiveDepth?.();
          return { t: s.presentedTime ?? null, index: a?.frameIndex ?? null, precision: a?.precision ?? null };
        })())`),
      );
      return state.precision === "exact" && state.index === frameAt(state.t);
    },
    20_000,
  );
  return Date.now() - started;
}

async function stopSamples(browser) {
  return JSON.parse(
    await browser.evaluate("JSON.stringify(globalThis.__mbDepth.stop())"),
  );
}

async function screenshot(browser, name) {
  if (!flags.screens) return;
  await fs.writeFile(
    path.join(flags.screens, name),
    Buffer.from(await browser.screenshot(), "base64"),
  );
}

function renderSummary(report) {
  const lines = [
    `Depth on the ${report.mediaPath} path, ${report.frameCount} frames: ${report.userAgent}`,
    `- Depth switch: ${JSON.stringify(report.depthSwitch)}`,
  ];

  for (const phase of report.phases) {
    const { name, wrongExamples, ...numbers } = phase;
    lines.push(`- ${name}: ${JSON.stringify(numbers)}`);
    if (wrongExamples.length > 0) {
      lines.push(`  wrong: ${JSON.stringify(wrongExamples)}`);
    }
  }
  return lines.join("\n");
}

async function waitFor(browser, label, check, timeoutMs = 20_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
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
    async mouse(type, x, y) {
      await cdp.send("Input.dispatchMouseEvent", {
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: type === "mouseMoved" ? 0 : 1,
        pointerType: "mouse",
        type,
        x: Math.round(x),
        y,
      });
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
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
