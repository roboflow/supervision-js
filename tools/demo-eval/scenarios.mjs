/* Measurement scenarios run against the demo page and the stress battery. */

import {
  CdpSession,
  closeTarget,
  delay,
  isReachable,
  openTarget,
} from "./cdp.mjs";

const TRACE_CATEGORIES = [
  "disabled-by-default-devtools.timeline",
  "devtools.timeline",
];
const TRACE_WINDOW_MS = 6000;
const SETTLE_MS = 600;
const VIEWPORT = { width: 1500, height: 1150, deviceScaleFactor: 1 };
const SEEK_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const STEP_COUNT = 6;
const RECT_TOLERANCE_PX = 2;
/* A playing window that advances less than this fraction of wall time is not a
 * measurement of playback, whatever the trace says. */
const MIN_ADVANCE_RATIO = 0.25;
const SEEK_P95_LIMIT_MS = 250;
const STEP_P95_LIMIT_MS = 80;
const DOM_PAINT_RATE_MULTIPLIER = 3;
const DETECTION_SETTLE_MS = 8000;
const BATTERY_TIMEOUT_MS = 900_000;

const SNAPSHOT = `(() => {
  const renderer = window.__demoRenderer;
  const state = renderer.getState();
  return {
    at: Date.now(),
    currentTime: state.currentTime,
    playbackState: state.playbackState,
    presentedFrames: state.presentedFrames,
    renderCount: renderer.getRenderCount(),
    detectionTime: state.activeDetectionFrameTime,
    detectionCount: state.activeDetectionCount,
    detectionBufferStatus: state.detectionBuffer.status,
  };
})()`;

const GEOMETRY = `(() => {
  const canvas = document.querySelector("canvas");
  const box = canvas ? canvas.getBoundingClientRect() : null;
  return {
    canvas: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
  };
})()`;

class Invalid extends Error {}

function invalid(reason) {
  throw new Invalid(reason);
}

export async function openDemoPage(
  chromeDebugUrl,
  url,
  readyTimeoutMs = 60_000,
) {
  const target = await openTarget(chromeDebugUrl, url);
  const session = await CdpSession.attach(target.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    mobile: false,
  });
  const info = await waitForRenderer(session, readyTimeoutMs);
  return { session, targetId: target.id, info };
}

async function waitForRenderer(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.readJson(`(() => {
      const renderer = window.__demoRenderer;
      if (!renderer) return { ready: false, reason: "window.__demoRenderer is absent" };
      const state = renderer.getState();
      if (state.source.status !== "ready" || !(state.duration > 0)) {
        return { ready: false, reason: "media source status " + state.source.status };
      }
      return {
        ready: true,
        duration: state.duration,
        frameRate: state.source.estimatedFrameRate,
        backend: state.rendererBackend,
        mediaWidth: state.mediaWidth,
        mediaHeight: state.mediaHeight,
      };
    })()`);
    if (last.ready) return last;
    await delay(500);
  }
  invalid(`demo renderer never became ready: ${last?.reason ?? "no response"}`);
}

/**
 * Runs one measurement attempt and discards it when the page navigated while it
 * was in flight: a dev-server reload silently restarts the renderer mid-window.
 */
async function attemptStable(
  session,
  attempts,
  measure,
  { guardPatches = false } = {},
) {
  let lastReason = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const navMark = session.navigations;
    const patchMark = session.devServerPatches;
    try {
      const result = await measure(attempt);
      const disturbed = disturbance(session, navMark, patchMark, guardPatches);
      if (disturbed) {
        lastReason = disturbed;
        if (session.navigations !== navMark)
          await waitForRenderer(session, 60_000);
        continue;
      }
      return result;
    } catch (error) {
      const reloaded = navigatedAway(session, navMark, error);
      if (!(error instanceof Invalid) && !reloaded) throw error;
      lastReason = reloaded
        ? "the page reloaded during the measurement window"
        : error.message;
      if (reloaded) await waitForRenderer(session, 60_000);
    }
  }
  invalid(`${lastReason} (after ${attempts} attempts)`);
}

/* A reload takes the renderer and the execution context with it, so the
 * failure surfaces as a protocol error or a missing global before the
 * navigation event is even counted. */
function navigatedAway(session, navMark, error) {
  return (
    session.navigations !== navMark ||
    /navigated or closed|__demoRenderer|reading '(getState|pause|play|seek)'/.test(
      error.message,
    )
  );
}

function disturbance(session, navMark, patchMark, guardPatches) {
  if (session.navigations !== navMark) {
    return "the page reloaded during the measurement window";
  }
  if (guardPatches && session.devServerPatches !== patchMark) {
    return "the dev server hot-patched the page during the measurement window";
  }
  return null;
}

function bucketPaints(events) {
  const buckets = new Map();
  let paintCount = 0;
  const counts = { Layout: 0, Commit: 0, UpdateLayoutTree: 0 };
  for (const event of events) {
    if (event.name in counts) counts[event.name] += 1;
    if (event.name !== "Paint") continue;
    paintCount += 1;
    const clip = event.args?.data?.clip;
    if (!clip) continue;
    const width = Math.round(Math.abs(clip[2] - clip[0]));
    const height = Math.round(Math.abs(clip[5] - clip[1]));
    const key = `${width}x${height}`;
    const bucket = buckets.get(key) ?? { count: 0, width, height };
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  const rects = [...buckets.values()].sort((a, b) => b.count - a.count);
  return { paintCount, counts, rects };
}

function matchesBox(rect, box) {
  return (
    box !== null &&
    Math.abs(rect.width - box.width) <= RECT_TOLERANCE_PX &&
    Math.abs(rect.height - box.height) <= RECT_TOLERANCE_PX
  );
}

/**
 * Finds the rect class the canvas presents through. The canvas own box is the
 * clean case; a canvas that backs most of the page instead presents through the
 * viewport-sized layer rect, and that class is the one to exclude from the DOM
 * paint budget.
 */
function findCanvasRect(rects, geometry) {
  const own = rects.find((rect) => matchesBox(rect, geometry.canvas));
  if (own) return { ...own, source: "canvas-box" };
  const canvas = geometry.canvas;
  if (!canvas) return null;
  const coverage =
    (canvas.width * canvas.height) /
    (geometry.viewport.width * geometry.viewport.height);
  if (coverage < 0.5) return null;
  const viewportRect = rects.find((rect) =>
    matchesBox(rect, geometry.viewport),
  );
  return viewportRect ? { ...viewportRect, source: "viewport-box" } : null;
}

/**
 * Playback rates come from the wall time actually spanned by the two
 * snapshots, which is longer than the trace window: stopping a trace and
 * draining it takes seconds during which the media keeps playing.
 */
function advancement(before, after, frameRate) {
  const elapsedSeconds = round((after.at - before.at) / 1000, 3);
  const mediaAdvancedSeconds = round(after.currentTime - before.currentTime, 3);
  const presentedFrameDelta = after.presentedFrames - before.presentedFrames;
  const startedPlaying = before.playbackState === "playing";
  const endedPlaying = after.playbackState === "playing";
  const advanced = mediaAdvancedSeconds >= elapsedSeconds * MIN_ADVANCE_RATIO;
  const usePresentedFrames = presentedFrameDelta > 0;
  return {
    elapsedSeconds,
    mediaAdvancedSeconds,
    presentedFrameDelta,
    playbackState: endedPlaying ? "playing" : after.playbackState,
    advanced,
    presentRate: round(
      usePresentedFrames
        ? presentedFrameDelta / elapsedSeconds
        : (mediaAdvancedSeconds * frameRate) / elapsedSeconds,
      2,
    ),
    presentRateSource: usePresentedFrames ? "presentedFrames" : "mediaClock",
    starved:
      startedPlaying && endedPlaying && !advanced && presentedFrameDelta === 0,
  };
}

const STARVATION_NOTE =
  "decoder starvation: playback state stayed playing, the media clock froze " +
  "and no frames were presented. Another tab holding the hardware decoder " +
  "sessions produces exactly this signature; close it and re-run.";

export async function runPaints(session, info, attempts) {
  const geometry = await session.readJson(GEOMETRY);
  const windowSeconds = TRACE_WINDOW_MS / 1000;

  const measure = async () => {
    await session.send("Page.bringToFront");
    await session.evaluate("window.__demoRenderer.pause(); 1");
    await delay(SETTLE_MS);
    const pausedBefore = await session.readJson(SNAPSHOT);
    const pausedEvents = await session.trace(TRACE_CATEGORIES, TRACE_WINDOW_MS);
    const pausedAfter = await session.readJson(SNAPSHOT);

    await session.evaluate("window.__demoRenderer.play(); 1");
    await delay(SETTLE_MS);
    const playingBefore = await session.readJson(SNAPSHOT);
    const playingEvents = await session.trace(
      TRACE_CATEGORIES,
      TRACE_WINDOW_MS,
    );
    const playingAfter = await session.readJson(SNAPSHOT);
    await session.evaluate("window.__demoRenderer.pause(); 1");

    const playingMotion = advancement(
      playingBefore,
      playingAfter,
      info.frameRate,
    );
    if (playingMotion.starved) invalid(STARVATION_NOTE);
    if (!playingMotion.advanced) {
      invalid(
        `media advanced only ${playingMotion.mediaAdvancedSeconds}s over ` +
          `${playingMotion.elapsedSeconds}s of playback (state ` +
          `${playingMotion.playbackState})`,
      );
    }
    return {
      paused: {
        ...buildPhase(pausedEvents, pausedBefore, pausedAfter, geometry),
        ...advancement(pausedBefore, pausedAfter, info.frameRate),
      },
      playing: {
        ...buildPhase(playingEvents, playingBefore, playingAfter, geometry),
        ...playingMotion,
      },
    };
  };

  const phases = await attemptStable(session, attempts, measure, {
    guardPatches: true,
  });
  const excluded = phases.playing.canvasPaintCount;
  const domPaintCount = phases.playing.paintCount - excluded;
  const domPaintRate = round(domPaintCount / windowSeconds, 2);
  const domPaintRateLimit = round(
    phases.playing.presentRate * DOM_PAINT_RATE_MULTIPLIER,
    2,
  );

  const failures = [];
  if (phases.paused.paintCount !== 0) {
    failures.push(
      `paints: paused window painted ${phases.paused.paintCount} times, expected 0`,
    );
  }
  if (domPaintRate >= domPaintRateLimit) {
    failures.push(
      `paints: DOM paint rate ${domPaintRate}/s is not under ${domPaintRateLimit}/s ` +
        `(${DOM_PAINT_RATE_MULTIPLIER}x the ${phases.playing.presentRate}/s present rate)`,
    );
  }

  return {
    scenario: {
      windowSeconds,
      frameRate: info.frameRate,
      geometry,
      paused: phases.paused,
      playing: {
        ...phases.playing,
        domPaintCount,
        domPaintRate,
        domPaintRateLimit,
      },
    },
    failures,
  };
}

function buildPhase(events, before, after, geometry) {
  const windowSeconds = TRACE_WINDOW_MS / 1000;
  const { paintCount, counts, rects } = bucketPaints(events);
  const canvasRect = findCanvasRect(rects, geometry);
  return {
    paintCount,
    paintRate: round(paintCount / windowSeconds, 2),
    layoutCount: counts.Layout,
    updateLayoutTreeCount: counts.UpdateLayoutTree,
    commitCount: counts.Commit,
    sceneRenderDelta: after.renderCount - before.renderCount,
    canvasRectClass: canvasRect
      ? `${canvasRect.width}x${canvasRect.height}`
      : null,
    canvasRectSource: canvasRect ? canvasRect.source : null,
    canvasPaintCount: canvasRect ? canvasRect.count : 0,
    rects: rects.slice(0, 8).map((rect) => ({
      size: `${rect.width}x${rect.height}`,
      count: rect.count,
    })),
  };
}

export async function runSync(session, info, attempts) {
  const framePeriodMs = 1000 / info.frameRate;
  const measure = async () => {
    await session.send("Page.bringToFront");
    await session.evaluate("window.__demoRenderer.pause(); 1");
    const seeks = await session.readJson(
      `(async () => {
        const renderer = window.__demoRenderer;
        const duration = renderer.getState().duration;
        const results = [];
        /* The load transient can swallow the first seek, so spend it here. */
        renderer.pause();
        await renderer.seek(duration * 0.5);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        for (const fraction of ${JSON.stringify(SEEK_FRACTIONS)}) {
          const requested = Number((duration * fraction).toFixed(3));
          /* The buffer window follows the seek immediately while the active
           * detection frame keeps serving the previous position, so freshness
           * is the wait condition and accuracy is what gets measured after. */
          const stale = renderer.getState().activeDetectionFrameTime;
          await renderer.seek(requested);
          const started = performance.now();
          let state = renderer.getState();
          while (performance.now() - started < ${DETECTION_SETTLE_MS}) {
            state = renderer.getState();
            const buffer = state.detectionBuffer;
            const covered =
              buffer.status === "ready" &&
              buffer.bufferStartTime <= state.currentTime &&
              state.currentTime <= buffer.bufferEndTime;
            const fresh =
              state.activeDetectionFrameTime !== null &&
              state.activeDetectionFrameTime !== stale;
            if (covered && fresh) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          results.push({
            requested,
            currentTime: state.currentTime,
            detectionTime: state.activeDetectionFrameTime,
            detectionCount: state.activeDetectionCount,
            detectionBufferStatus: state.detectionBuffer.status,
            detectionBufferWindow: [
              state.detectionBuffer.bufferStartTime,
              state.detectionBuffer.bufferEndTime,
            ],
            settleMs: Math.round(performance.now() - started),
          });
        }
        return results;
      })()`,
      { timeoutMs: 120_000 },
    );
    return seeks;
  };

  const seeks = await attemptStable(session, attempts, measure, {
    guardPatches: true,
  });
  const failures = [];
  const rows = seeks.map((seek) => {
    const requestedToCurrentMs = round(
      (seek.currentTime - seek.requested) * 1000,
      1,
    );
    const currentToDetectionMs =
      seek.detectionTime === null
        ? null
        : round((seek.currentTime - seek.detectionTime) * 1000, 1);
    if (currentToDetectionMs === null) {
      failures.push(
        `sync: no detection frame landed at ${seek.requested}s ` +
          `(buffer ${seek.detectionBufferStatus})`,
      );
    } else if (Math.abs(currentToDetectionMs) >= framePeriodMs) {
      failures.push(
        `sync: ${seek.requested}s landed ${currentToDetectionMs}ms from its ` +
          `detection, over the ${round(framePeriodMs, 1)}ms frame period`,
      );
    }
    return { ...seek, requestedToCurrentMs, currentToDetectionMs };
  });

  return {
    scenario: {
      frameRate: info.frameRate,
      framePeriodMs: round(framePeriodMs, 2),
      seeks: rows,
    },
    failures,
  };
}

export async function runLatency(session, info, attempts) {
  const measure = async () => {
    await session.send("Page.bringToFront");
    return session.readJson(
      `(async () => {
        const renderer = window.__demoRenderer;
        const duration = renderer.getState().duration;
        renderer.pause();
        /* One untimed pass so cold decode and buffer setup stay out of the numbers. */
        for (const fraction of [0.2, 0.6]) await renderer.seek(duration * fraction);
        await renderer.stepForward();
        await renderer.stepBackward();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const seeks = [];
        for (const fraction of ${JSON.stringify(SEEK_FRACTIONS)}) {
          const requested = Number((duration * fraction).toFixed(3));
          const started = performance.now();
          await renderer.seek(requested);
          seeks.push({ requested, ms: Number((performance.now() - started).toFixed(1)) });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const steps = [];
        for (let index = 0; index < ${STEP_COUNT}; index += 1) {
          const forward = index % 2 === 0;
          const started = performance.now();
          await (forward ? renderer.stepForward() : renderer.stepBackward());
          steps.push({
            direction: forward ? "forward" : "backward",
            ms: Number((performance.now() - started).toFixed(1)),
          });
        }
        return { seeks, steps, currentTime: renderer.getState().currentTime };
      })()`,
      { timeoutMs: 180_000 },
    );
  };

  const timings = await attemptStable(session, attempts, measure, {
    guardPatches: true,
  });
  const seekStats = stats(timings.seeks.map((seek) => seek.ms));
  const stepStats = stats(timings.steps.map((step) => step.ms));

  const failures = [];
  if (seekStats.p95 >= SEEK_P95_LIMIT_MS) {
    failures.push(
      `latency: seek p95 ${seekStats.p95}ms is not under ${SEEK_P95_LIMIT_MS}ms`,
    );
  }
  if (stepStats.p95 >= STEP_P95_LIMIT_MS) {
    failures.push(
      `latency: step p95 ${stepStats.p95}ms is not under ${STEP_P95_LIMIT_MS}ms`,
    );
  }

  return {
    scenario: {
      frameRate: info.frameRate,
      seek: {
        ...seekStats,
        limitMs: SEEK_P95_LIMIT_MS,
        samples: timings.seeks,
      },
      step: {
        ...stepStats,
        limitMs: STEP_P95_LIMIT_MS,
        samples: timings.steps,
      },
    },
    failures,
  };
}

export async function runBattery(chromeDebugUrl, storybookUrl, batteryUrl) {
  const storyUrl = `${storybookUrl.replace(/\/$/, "")}/iframe.html?id=framesampler--default&viewMode=story`;
  // A storybook dev server that is compiling can sit on a request for tens of
  // seconds; a short probe would report it absent.
  if (!(await isReachable(storyUrl, 45_000))) {
    return { skipped: `storybook is not serving ${storyUrl}` };
  }
  if (!(await isReachable(batteryUrl, 15_000))) {
    return { skipped: `stress battery is not served at ${batteryUrl}` };
  }

  const target = await openTarget(chromeDebugUrl, storyUrl);
  let session = null;
  try {
    session = await CdpSession.attach(target.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 1180,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The harness drives the engine through requestAnimationFrame, which a
    // backgrounded target does not run.
    await session.send("Page.bringToFront");

    const deadline = Date.now() + 60_000;
    let mounted = false;
    while (Date.now() < deadline) {
      mounted = await session.evaluate(
        `Boolean(document.querySelector("select") && document.querySelector("canvas"))`,
      );
      if (mounted) break;
      await delay(1000);
    }
    if (!mounted) {
      return { skipped: "FrameSampler story never mounted a source select" };
    }
    await delay(4000);

    await session.evaluate(
      `new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = ${JSON.stringify(batteryUrl)} + "?ts=" + Math.random();
        script.onload = () => resolve(1);
        script.onerror = () => reject(new Error("stress battery failed to load"));
        document.head.appendChild(script);
      })`,
    );
    const armed = await session.readJson("window.__vr.arm()", {
      timeoutMs: 120_000,
    });
    const report = await session.readJson("window.__vr.battery(1)", {
      timeoutMs: BATTERY_TIMEOUT_MS,
    });

    const byScenario = Object.entries(report.byScenario).map(
      ([name, ratio]) => {
        const [passed, total] = ratio.split("/").map(Number);
        return { name, ratio, verdict: passed === total ? "pass" : "fail" };
      },
    );
    const failures = byScenario
      .filter((entry) => entry.verdict === "fail")
      .map((entry) => `battery: ${entry.name} passed ${entry.ratio}`);
    for (const run of report.failing) {
      if (run.threw) {
        failures.push(`battery: ${run.name} threw ${run.threw}`);
      } else if (!run.alive) {
        failures.push(`battery: ${run.name} left the frame pump dead`);
      }
    }

    return {
      scenario: {
        storyUrl,
        batteryUrl,
        armed,
        total: report.total,
        failures: report.failures,
        byScenario,
        failing: report.failing,
      },
      failures: [...new Set(failures)],
    };
  } finally {
    session?.close();
    await closeTarget(chromeDebugUrl, target.id);
  }
}

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { Invalid, STARVATION_NOTE };
