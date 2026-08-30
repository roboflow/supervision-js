/* Measurement scenarios run against the demo page and the stress battery. */

import {
  CdpSession,
  closeTarget,
  delay,
  isReachable,
  openTarget,
  reloadPage,
} from "./cdp.mjs";
import {
  at,
  FIXTURE_PREFIX,
  fixtureHook,
  Hook,
  openControls,
  openTab,
  RUN_ATTRIBUTE,
  SOURCE_TAB,
  startingAt,
} from "./hooks.mjs";
import { percentile, round } from "./stats.mjs";

const VIEWPORT = { width: 1500, height: 1150, deviceScaleFactor: 1 };
const SEEK_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const STEP_COUNT = 6;
/* A playing window that advances less than this fraction of wall time is not a
 * measurement of playback, whatever the trace says. */
const MIN_ADVANCE_RATIO = 0.25;
const SEEK_P95_LIMIT_MS = 250;
const STEP_P95_LIMIT_MS = 80;
const DETECTION_SETTLE_MS = 8000;
/* How long a seek may take to answer with a covered, genuinely new detection.
 * Fifteen seeks across three runs settled in 100ms to 126ms, so a seek spending
 * four times that is waiting on something, and one that never settles rides the
 * DETECTION_SETTLE_MS deadline out and lands far above this. */
const SEEK_SETTLE_LIMIT_MS = 500;
const BATTERY_TIMEOUT_MS = 900_000;
/* The basketball clip, under whichever sample the demo is offering it. At its
 * opening confidence gate the detections thicken from 4.4 a frame to a plateau
 * of 11.8 to 13.1 from media 3 onwards, which is the half of the clip the stall
 * lived in, and nothing else in this harness selects it. The first id the demo
 * answers to wins. */
const CADENCE_FIXTURE_IDS = ["basketball_sam3"];
const CADENCE_HEAD_SECONDS = 0.3;
/* Kept clear of the clip end so a window cannot wrap into the next lap. */
const CADENCE_TAIL_SECONDS = 0.5;
/* The mark the stall appeared past, and the position the original diagnosis
 * started playback from to reproduce it cold. */
const CADENCE_LATE_START_SECONDS = 4.5;
const CADENCE_LATE_PLAY_SECONDS = 3.5;
const CADENCE_MIN_LATE_SPAN_SECONDS = 2;
const CADENCE_SEEK_SETTLE_MS = 700;
const CADENCE_BUCKET_SECONDS = 1;
const CADENCE_SAMPLE_TIMEOUT_MS = 120_000;
/* Intervals a media second needs before its rate is a rate. A bucket at the
 * edge of a window holds whatever the edge left it, and one interval quotes a
 * whole second's cadence from a single frame period. */
const CADENCE_MIN_BUCKET_INTERVALS = 8;
/* The share of the source rate a media second has to present. Forty passes of
 * one unchanged build put the slowest judged second between 29.53/s and
 * 29.99/s against a 30.00/s source, so the floor sits 2.53/s under the worst of
 * them. The stall it exists for ran at 8/s, 0.27 of source. The tighter watch
 * on the same number is cadence.worstMediaSecondFps in the registry, which
 * carries no tolerance at all. */
const CADENCE_FLOOR_FRACTION = 0.9;
/* Frame periods a single frame may stay on screen. The longest hold across
 * those forty passes was 43.5ms against a 33.3ms period, and the stall held
 * frames for 101 to 123ms. */
const CADENCE_HOLD_PERIODS = 2;
/* No frame was held that long on any of the forty passes, and the longest hold
 * on any of them cleared the budget by 23ms. */
const CADENCE_SKIP_LIMIT = 0;
/* Frames the engine may book as late, as a share of the ones it painted in the
 * window. Two passes in forty booked a single late frame out of the 106 the
 * late-start window painted. A window whose frames are all arriving late books
 * them all. */
const CADENCE_LATE_FRAME_FRACTION = 0.02;
/* The two clocks count different things in different realms, so they are never
 * going to agree exactly; across forty passes they sat 0.03/s to 0.58/s
 * apart.
 * This is wide because its job is catching one of them going blind, which puts
 * them twenty apart, and not the tenths they honestly differ by. */
const CADENCE_AGREEMENT_LIMIT_FPS = 1.5;

class Invalid extends Error {}

function invalid(reason) {
  throw new Invalid(reason);
}

/* The demo remembers which view it was left in, and the Debug view carries
 * fifty-four readouts that rewrite ten times a second, work that lands inside
 * every page-wide frame time and long task this tool samples. Every number
 * here therefore states the view it was taken in, and the run picks one rather
 * than inheriting whatever the last person clicked. */
export const VIEW_MODE_STORAGE_KEY = "supervision-demo:view-mode";
export const VIEW_MODES = ["benchmarks", "demo", "debug"];

export async function openDemoPage(
  chromeDebugUrl,
  url,
  { readyTimeoutMs = 60_000, viewMode = "demo" } = {},
) {
  if (viewMode !== "as-is" && !VIEW_MODES.includes(viewMode)) {
    invalid(
      `unknown view mode "${viewMode}", expected as-is|${VIEW_MODES.join("|")}`,
    );
  }
  const target = await openTarget(chromeDebugUrl, url);
  const session = await CdpSession.attach(target.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    mobile: false,
  });
  if (viewMode !== "as-is") {
    const changed = await session.evaluate(
      `(() => {
        const key = ${JSON.stringify(VIEW_MODE_STORAGE_KEY)};
        if (localStorage.getItem(key) === ${JSON.stringify(viewMode)}) return false;
        localStorage.setItem(key, ${JSON.stringify(viewMode)});
        return true;
      })()`,
    );
    if (changed) await reloadPage(session);
  }
  const info = await waitForRenderer(session, readyTimeoutMs);
  const settled = await session.evaluate(
    `localStorage.getItem(${JSON.stringify(VIEW_MODE_STORAGE_KEY)}) ?? "demo"`,
  );
  if (settled !== "benchmarks") await openControls(session);
  const run = await readRunStamp(session);
  return {
    session,
    targetId: target.id,
    info: { ...info, viewMode: settled, ...run },
  };
}

/** The clip the demo opened on and the reader that opened it. */
async function readRunStamp(session) {
  const stamp = await session.readJson(`(() => {
    const shell = document.querySelector(${at(Hook.Shell)});
    if (!shell) return null;
    return {
      id: shell.getAttribute(${JSON.stringify(RUN_ATTRIBUTE.Fixture)}),
      label: shell.getAttribute(${JSON.stringify(RUN_ATTRIBUTE.FixtureLabel)}),
      mediaPath: shell.getAttribute(${JSON.stringify(RUN_ATTRIBUTE.MediaPath)}),
    };
  })()`);
  return {
    fixture: stamp?.id
      ? { id: stamp.id, label: stamp.label ?? stamp.id }
      : null,
    mediaPath: stamp?.mediaPath ?? null,
  };
}

async function waitForRenderer(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    // A page mid-navigation answers every evaluate with "target navigated or
    // closed", which is what waiting for it to come back looks like.
    last = await session
      .readJson(
        `(() => {
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
    })()`,
      )
      .catch((error) => ({ ready: false, reason: error.message }));
    if (last.ready) return last;
    await delay(500);
  }
  invalid(`demo renderer never became ready: ${last?.reason ?? "no response"}`);
}

/**
 * Runs one measurement attempt and discards it when the page navigated while it
 * was in flight: a dev-server reload silently restarts the renderer mid-window.
 *
 * The discarded attempt still drove the player, so the page it leaves behind
 * has the frames the next attempt is about to ask for already decoded. Every
 * attempt therefore starts from a reloaded page, except for the one caller
 * whose fixture would not survive the reload.
 */
async function attemptStable(
  session,
  attempts,
  measure,
  { guardPatches = false, keepPage = false } = {},
) {
  const recover = async () => {
    if (keepPage) {
      await waitForRenderer(session, 60_000);
      return;
    }
    await reloadPage(session);
    await waitForRenderer(session, 60_000);
    await openControls(session);
  };
  let lastReason = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const navMark = session.navigations;
    const patchMark = session.devServerPatches;
    try {
      const result = await measure(attempt);
      const disturbed = disturbance(session, navMark, patchMark, guardPatches);
      if (disturbed) {
        lastReason = disturbed;
        await recover();
        continue;
      }
      return result;
    } catch (error) {
      const reloaded = navigatedAway(session, navMark, error);
      if (!(error instanceof Invalid) && !reloaded) throw error;
      lastReason = reloaded
        ? "the page reloaded during the measurement window"
        : error.message;
      await recover();
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
    starved:
      startedPlaying && endedPlaying && !advanced && presentedFrameDelta === 0,
  };
}

const STARVATION_NOTE =
  "decoder starvation: playback state stayed playing, the media clock froze " +
  "and no frames were presented. Another tab holding the hardware decoder " +
  "sessions produces exactly this signature; close it and re-run.";

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
            /* The buffer window keeps counting across laps while the playhead
             * wraps at the clip end, so the two only compare after the
             * playhead is carried into the lap the window is quoting. */
            const lap =
              Math.round((buffer.bufferStartTime - state.currentTime) / duration) *
              duration;
            const covered =
              buffer.status === "ready" &&
              buffer.bufferStartTime <= state.currentTime + lap &&
              state.currentTime + lap <= buffer.bufferEndTime;
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
    if (seek.settleMs >= SEEK_SETTLE_LIMIT_MS) {
      failures.push(
        `sync: ${seek.requested}s took ${seek.settleMs}ms to answer with a ` +
          `covered, fresh detection, over the ${SEEK_SETTLE_LIMIT_MS}ms budget`,
      );
    }
    return { ...seek, requestedToCurrentMs, currentToDetectionMs };
  });

  return {
    scenario: {
      frameRate: info.frameRate,
      framePeriodMs: round(framePeriodMs, 2),
      settleLimitMs: SEEK_SETTLE_LIMIT_MS,
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

/**
 * The keypoint fixture, played through in windows that between them cover every
 * media second of the clip.
 *
 * The stall this scenario exists for was positional: 33ms a frame up to media
 * 4.0 and 101 to 123ms past it. A window that seeks once into the opening and
 * samples a few hundred frames therefore reports a healthy player from the
 * healthy half of the clip, so one window here starts cold past that mark and
 * the rate is judged per media second.
 *
 * Both clocks are read because they fail differently. The consumer counts
 * presented frames against wall time on the main thread; the engine counts
 * paints against its own playing time in the worker. A stall only one of them
 * can see is a stall in the instrument.
 */
export async function runCadence(session, info, attempts) {
  await session.send("Page.bringToFront");
  const opening = await readFixtureButtons(session);
  const pressed = opening.find((button) => button.pressed);
  if (!pressed) {
    invalid(
      "no sample fixture is selected, so this scenario has nothing to put " +
        "back when it is done; the demo is in upload mode or the source " +
        "controls changed",
    );
  }

  const id = CADENCE_FIXTURE_IDS.find((candidate) =>
    opening.some((button) => button.id === candidate),
  );
  if (!id) {
    invalid(
      "the demo is not offering the basketball clip as " +
        `${CADENCE_FIXTURE_IDS.map((name) => `"${name}"`).join(" or ")}; ` +
        `it has ${opening.map((button) => `"${button.id}"`).join(", ")}`,
    );
  }

  try {
    const fixture = await selectFixture(session, id);
    return await measureCadence(session, fixture, attempts);
  } finally {
    await selectFixture(session, pressed.id).catch(() => {});
    /* The panel this left open is mounted for every scenario that follows, and
     * a mounted panel is main-thread work the next one charges to the library. */
    await openControls(session).catch(() => {});
  }
}

async function measureCadence(session, fixture, attempts) {
  const sourceRateFps = fixture.frameRate;
  const framePeriodMs = 1000 / sourceRateFps;
  const holdLimitMs = round(framePeriodMs * CADENCE_HOLD_PERIODS, 1);
  const floorFps = round(sourceRateFps * CADENCE_FLOOR_FRACTION, 2);
  const plans = planCadenceWindows(fixture.duration);

  const windows = [];
  for (const plan of plans) {
    const sample = await attemptStable(
      session,
      attempts,
      async () => {
        await session.send("Page.bringToFront");
        return session.readJson(
          cadenceSampler(plan.startSeconds, plan.spanSeconds),
          { timeoutMs: CADENCE_SAMPLE_TIMEOUT_MS },
        );
      },
      {
        guardPatches: true,
        /* This scenario picked its own fixture and puts the demo's back when it
         * is done. A reload between attempts would drop it onto the default
         * clip while every number it reported still named the basketball one. */
        keepPage: true,
      },
    );
    windows.push(
      summariseCadenceWindow(plan, sample, { sourceRateFps, holdLimitMs }),
    );
  }

  const scenario = {
    fixture,
    sourceRateFps: round(sourceRateFps, 3),
    framePeriodMs: round(framePeriodMs, 2),
    bucketSeconds: CADENCE_BUCKET_SECONDS,
    minBucketIntervals: CADENCE_MIN_BUCKET_INTERVALS,
    floorFraction: CADENCE_FLOOR_FRACTION,
    floorFps,
    holdPeriods: CADENCE_HOLD_PERIODS,
    holdLimitMs,
    skipLimit: CADENCE_SKIP_LIMIT,
    lateFrameFraction: CADENCE_LATE_FRAME_FRACTION,
    agreementLimitFps: CADENCE_AGREEMENT_LIMIT_FPS,
    coverage: coverageOf(plans, windows),
    windows,
  };
  return { scenario, failures: judgeCadence(scenario) };
}

/**
 * One window over the whole clip and one that starts cold past the mark the
 * stall appeared at. The two overlap on purpose: a media second sitting at the
 * thin edge of one window is in the body of the other, so every second of the
 * clip is judged from a bucket with enough intervals to be a rate.
 */
function planCadenceWindows(duration) {
  const wholeClipSpan = round(
    duration - CADENCE_HEAD_SECONDS - CADENCE_TAIL_SECONDS,
    3,
  );
  const lateSpan = round(
    Math.min(
      CADENCE_LATE_PLAY_SECONDS,
      duration - CADENCE_LATE_START_SECONDS - CADENCE_TAIL_SECONDS,
    ),
    3,
  );
  if (lateSpan < CADENCE_MIN_LATE_SPAN_SECONDS) {
    invalid(
      `the basketball fixture runs ${duration}s, which leaves ${lateSpan}s to ` +
        `play from ${CADENCE_LATE_START_SECONDS}s; the window that starts ` +
        `past the stall needs ${CADENCE_MIN_LATE_SPAN_SECONDS}s`,
    );
  }
  return [
    {
      name: "whole-clip",
      startSeconds: CADENCE_HEAD_SECONDS,
      spanSeconds: wholeClipSpan,
    },
    {
      name: "late-start",
      startSeconds: CADENCE_LATE_START_SECONDS,
      spanSeconds: lateSpan,
    },
  ];
}

/**
 * Which media seconds the windows judged, against the ones the clip owes.
 *
 * This scenario was written to close a suite that measured playback in a single
 * early window. Without a coverage reading, windows that creep back towards the
 * opening keep reporting a pass over less and less of the clip.
 */
function coverageOf(plans, windows) {
  const judged = new Set(
    windows.flatMap((window) =>
      window.buckets
        .filter((bucket) => bucket.judged)
        .map((bucket) => bucket.second),
    ),
  );
  const whole = plans[0];
  const fromSecond = Math.floor(whole.startSeconds);
  const toSecond = Math.ceil(whole.startSeconds + whole.spanSeconds) - 1;
  const owed = [];
  for (let second = fromSecond; second <= toSecond; second += 1) {
    owed.push(second);
  }
  return {
    fromSecond,
    toSecond,
    judgedSeconds: owed.filter((second) => judged.has(second)),
    missingSeconds: owed.filter((second) => !judged.has(second)),
  };
}

function summariseCadenceWindow(plan, sample, { sourceRateFps, holdLimitMs }) {
  if (!sample.tap) {
    invalid(
      "window.__demoEngineDiagnostics is absent, so the engine's own count of " +
        "what it painted cannot be read; no web video engine source is open",
    );
  }
  if (sample.visibility !== "visible") {
    invalid(
      `the demo tab was ${sample.visibility} during the ${plan.name} window; ` +
        "a backgrounded tab presents nothing",
    );
  }
  if (sample.trace === null) {
    invalid(
      `the engine kept no record of what it painted during the ${plan.name} window`,
    );
  }
  if (sample.trace.droppedEvents > 0) {
    invalid(
      `the engine's event ring overwrote ${sample.trace.droppedEvents} entries ` +
        `during the ${plan.name} window, so it does not reach back to the start of it`,
    );
  }

  const first = sample.samples[0];
  const last = sample.samples.at(-1);
  /* Every floor here is a share of the source frame rate, which is a statement
   * about presented cadence only while the transport is running at 1x. */
  const rates = [
    ...new Set(sample.samples.map((reading) => reading.playbackRate)),
  ];
  if (rates.length !== 1 || rates[0] !== 1) {
    invalid(
      `the transport ran the ${plan.name} window at ${rates.join(" then ")}x, ` +
        "so what it presented cannot be read against the source frame rate",
    );
  }
  const motion = advancement(first, last, sourceRateFps);
  if (motion.starved) invalid(STARVATION_NOTE);
  if (!motion.advanced) {
    invalid(
      `media advanced only ${motion.mediaAdvancedSeconds}s over ` +
        `${motion.elapsedSeconds}s of the ${plan.name} window (state ` +
        `${motion.playbackState})`,
    );
  }

  const paints = bucketPaintsByMediaSecond(sample.trace.paints, holdLimitMs);
  if (paints.buckets.length === 0) {
    invalid(
      `the engine painted nothing it could place in the clip during the ` +
        `${plan.name} window`,
    );
  }

  const engineFps = sample.trace.summary.effectivePaintFps;
  return {
    name: plan.name,
    startSeconds: plan.startSeconds,
    spanSeconds: plan.spanSeconds,
    consumer: {
      fps: motion.presentRate,
      presentedFrames: motion.presentedFrameDelta,
      wallSeconds: motion.elapsedSeconds,
      mediaAdvancedSeconds: motion.mediaAdvancedSeconds,
    },
    engine: {
      fps: engineFps === null ? null : round(engineFps, 2),
      paints: sample.trace.paints.length,
      lateFrames: sample.trace.summary.lateFrames,
      stalls: sample.trace.summary.stalls,
      maxCatchUpMs: sample.trace.summary.maxCatchUpMs,
      longestHoldMs: paints.longestHoldMs,
      skips: paints.skips,
      backwardPaints: paints.backwardPaints,
    },
    disagreementFps:
      engineFps === null
        ? null
        : round(Math.abs(engineFps - motion.presentRate), 2),
    buckets: paints.buckets,
  };
}

/**
 * Paints grouped by the media second each one landed in, so the rate is read
 * where it was earned. An average over a window spends a stalled half of a clip
 * against a healthy half and reports the mean of the two.
 */
function bucketPaintsByMediaSecond(paints, holdLimitMs) {
  const placed = paints.filter(
    (paint) => typeof paint.mediaTimeMs === "number",
  );
  const buckets = new Map();
  let backwardPaints = 0;
  let longestHoldMs = 0;
  let skips = 0;

  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (current.mediaTimeMs <= previous.mediaTimeMs) {
      backwardPaints += 1;
      continue;
    }
    const holdMs = current.tMs - previous.tMs;
    if (holdMs > longestHoldMs) longestHoldMs = holdMs;
    if (holdMs > holdLimitMs) skips += 1;
    const second =
      Math.floor(current.mediaTimeMs / (CADENCE_BUCKET_SECONDS * 1000)) *
      CADENCE_BUCKET_SECONDS;
    const bucket = buckets.get(second) ?? {
      second,
      intervals: 0,
      wallMs: 0,
      longestHoldMs: 0,
    };
    bucket.intervals += 1;
    bucket.wallMs += holdMs;
    if (holdMs > bucket.longestHoldMs) bucket.longestHoldMs = holdMs;
    buckets.set(second, bucket);
  }

  return {
    backwardPaints,
    longestHoldMs: round(longestHoldMs, 1),
    skips,
    buckets: [...buckets.values()]
      .sort((left, right) => left.second - right.second)
      .map((bucket) => ({
        second: bucket.second,
        intervals: bucket.intervals,
        fps: round(bucket.intervals / (bucket.wallMs / 1000), 2),
        longestHoldMs: round(bucket.longestHoldMs, 1),
        judged: bucket.intervals >= CADENCE_MIN_BUCKET_INTERVALS,
      })),
  };
}

/** Every gate this scenario carries, over the numbers alone. */
export function judgeCadence(scenario) {
  const failures = [];

  for (const window of scenario.windows) {
    for (const bucket of window.buckets) {
      if (!bucket.judged) continue;
      if (bucket.fps < scenario.floorFps) {
        failures.push(
          `cadence: ${window.name} presented ${bucket.fps}/s at media ` +
            `${bucket.second}s, under the ${scenario.floorFps}/s floor ` +
            `(${scenario.floorFraction} of the ${scenario.sourceRateFps}/s source)`,
        );
      }
    }
    if (window.consumer.fps < scenario.floorFps) {
      failures.push(
        `cadence: ${window.name} put ${window.consumer.presentedFrames} frames ` +
          `on screen over ${window.consumer.wallSeconds}s, ${window.consumer.fps}/s ` +
          `against the ${scenario.floorFps}/s floor`,
      );
    }
    if (window.engine.fps !== null && window.engine.fps < scenario.floorFps) {
      failures.push(
        `cadence: ${window.name} painted ${window.engine.fps}/s by the engine's ` +
          `own ledger, under the ${scenario.floorFps}/s floor`,
      );
    }
    if (window.engine.fps === null) {
      failures.push(
        `cadence: the engine reported no paint rate for the ${window.name} ` +
          "window, so only the consumer clock saw it",
      );
    }
    if (window.engine.skips > scenario.skipLimit) {
      failures.push(
        `cadence: ${window.name} held ${window.engine.skips} frames longer than ` +
          `${scenario.holdLimitMs}ms (${scenario.holdPeriods} frame periods), ` +
          `longest ${window.engine.longestHoldMs}ms, over the ${scenario.skipLimit} allowed`,
      );
    }
    const lateFrameLimit = Math.floor(
      window.engine.paints * scenario.lateFrameFraction,
    );
    if (window.engine.lateFrames > lateFrameLimit) {
      failures.push(
        `cadence: the engine booked ${window.engine.lateFrames} of the ` +
          `${window.engine.paints} frames it painted over ${window.name} as late, ` +
          `over the ${lateFrameLimit} allowed`,
      );
    }
    if (window.engine.stalls > 0) {
      failures.push(
        `cadence: the engine ran dry ${window.engine.stalls} times over the ` +
          `${window.name} window`,
      );
    }
    if (
      window.disagreementFps !== null &&
      window.disagreementFps > scenario.agreementLimitFps
    ) {
      failures.push(
        `cadence: over ${window.name} the engine counted ${window.engine.fps}/s ` +
          `and the page counted ${window.consumer.fps}/s, ${window.disagreementFps}/s ` +
          `apart and over the ${scenario.agreementLimitFps}/s the two clocks may differ by`,
      );
    }
  }

  if (scenario.coverage.missingSeconds.length > 0) {
    failures.push(
      `cadence: media second${scenario.coverage.missingSeconds.length > 1 ? "s" : ""} ` +
        `${scenario.coverage.missingSeconds.join(", ")} of ` +
        `${scenario.coverage.fromSecond} to ${scenario.coverage.toSecond} carried ` +
        `fewer than ${scenario.minBucketIntervals} intervals in every window, so ` +
        "the clip was judged in part",
    );
  }
  return failures;
}

/** The per-window and per-media-second table the run summary prints. */
export function cadenceDetail(scenario, field) {
  const lines = [
    field(
      "fixture",
      `${scenario.fixture.label}  ${scenario.fixture.duration}s at ` +
        `${scenario.sourceRateFps}fps, ${scenario.fixture.backend}`,
    ),
    field(
      "floor",
      `${scenario.floorFps}/s per media second (${scenario.floorFraction} of source)`,
    ),
    field(
      "hold budget",
      `${scenario.skipLimit} frames held past ${scenario.holdLimitMs}ms ` +
        `(${scenario.holdPeriods} frame periods)`,
    ),
    field("clocks may differ by", `${scenario.agreementLimitFps}/s`),
    field(
      "media seconds judged",
      `${scenario.coverage.judgedSeconds.length} of ` +
        `${scenario.coverage.toSecond - scenario.coverage.fromSecond + 1}` +
        (scenario.coverage.missingSeconds.length > 0
          ? `  (missing ${scenario.coverage.missingSeconds.join(", ")})`
          : ""),
    ),
  ];

  for (const window of scenario.windows) {
    lines.push(
      "",
      field(
        `  ${window.name}`,
        `from ${window.startSeconds}s for ${window.spanSeconds}s`,
      ),
      field(
        "    engine / page",
        `${window.engine.fps ?? "none"}/s vs ${window.consumer.fps}/s ` +
          `(${window.disagreementFps ?? "none"} apart)`,
      ),
      field(
        "    engine ledger",
        `${window.engine.lateFrames} late, ${window.engine.stalls} stalls, ` +
          `${window.engine.maxCatchUpMs}ms peak catch-up`,
      ),
      field(
        "    longest hold / skips",
        `${window.engine.longestHoldMs}ms / ${window.engine.skips}`,
      ),
      `    ${"media".padEnd(10)}${"fps".padStart(8)}${"held".padStart(9)}${"n".padStart(6)}`,
    );
    for (const bucket of window.buckets) {
      lines.push(
        `    ${`${bucket.second}s`.padEnd(10)}${String(bucket.fps).padStart(8)}` +
          `${`${bucket.longestHoldMs}ms`.padStart(9)}${String(bucket.intervals).padStart(6)}` +
          `${bucket.judged ? "" : "  thin"}`,
      );
    }
  }
  return lines;
}

const FIXTURE_BUTTONS = `[...document.querySelectorAll(${startingAt(FIXTURE_PREFIX)})]
  .map((button) => ({
    id: button.getAttribute("data-eval").slice(${JSON.stringify(FIXTURE_PREFIX)}.length),
    label: button.textContent.trim(),
    pressed: button.getAttribute("aria-pressed") === "true",
    disabled: button.disabled,
  }))`;

async function readFixtureButtons(session) {
  await openTab(session, SOURCE_TAB);
  return session.readJson(FIXTURE_BUTTONS);
}

const clickFixture = (id) => `(() => {
  const button = document.querySelector(${at(fixtureHook(id))});
  if (!button) return { found: false };
  if (button.disabled) return { found: true, disabled: true };
  window.__demoEvalFixtureMark = window.__demoRenderer;
  button.click();
  return { found: true, disabled: false };
})()`;

/**
 * Switching sources tears the session down and builds another, so the renderer
 * the page answers with is a different object afterwards. Waiting for a ready
 * status alone would be answered by the outgoing one straight away.
 */
async function selectFixture(session, id, timeoutMs = 90_000) {
  const buttons = await readFixtureButtons(session);
  const wanted = buttons.find((button) => button.id === id);
  if (!wanted) {
    invalid(
      `the demo is not offering a "${id}" source; it has ` +
        `${buttons.map((button) => `"${button.id}"`).join(", ")}`,
    );
  }
  if (wanted.pressed) {
    const info = await waitForRenderer(session, timeoutMs);
    return { ...info, id, label: wanted.label };
  }

  const clicked = await session.readJson(clickFixture(id));
  if (clicked.disabled) {
    invalid(`the "${id}" source button was disabled when the sweep set it`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const swapped = await session
      .evaluate(
        "Boolean(window.__demoRenderer) && window.__demoRenderer !== window.__demoEvalFixtureMark",
      )
      .catch(() => false);
    if (swapped) {
      const info = await waitForRenderer(session, timeoutMs);
      await session.evaluate("delete window.__demoEvalFixtureMark; 1");
      return { ...info, id, label: wanted.label };
    }
    await delay(200);
  }
  invalid(`the demo stayed on its previous source after "${id}" was clicked`);
}

const cadenceSampler = (startSeconds, playSeconds) => `(async () => {
  const renderer = window.__demoRenderer;
  const tap = window.__demoEngineDiagnostics;
  if (!tap) return { tap: false };
  renderer.pause();
  await renderer.seek(${startSeconds});
  await new Promise((resolve) => setTimeout(resolve, ${CADENCE_SEEK_SETTLE_MS}));
  const samples = [];
  const sample = () => {
    const state = renderer.getState();
    samples.push({
      at: performance.now(),
      currentTime: state.currentTime,
      presentedFrames: state.presentedFrames,
      playbackRate: state.playbackRate,
      playbackState: state.playbackState,
    });
  };
  /* The engine assembles a snapshot only while a surface is subscribed, and the
   * Demo view subscribes to none, so the ledger reads null without this. */
  const stopBroadcast = tap.start();
  tap.armTrace();
  await renderer.play();
  sample();
  await new Promise((resolve) => {
    const deadline = performance.now() + ${Math.round(playSeconds * 1000)};
    const tick = () => {
      sample();
      if (performance.now() < deadline) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  renderer.pause();
  sample();
  const trace = await tap.exportTrace();
  tap.disarmTrace();
  stopBroadcast();
  return {
    tap: true,
    visibility: document.visibilityState,
    samples,
    trace: trace === null ? null : {
      durationMs: trace.durationMs,
      truncatedReason: trace.truncatedReason,
      droppedEvents: trace.coverage.events.dropped,
      summary: {
        effectivePaintFps: trace.summary.effectivePaintFps,
        lateFrames: trace.summary.lateFrames,
        stalls: trace.summary.stalls,
        maxCatchUpMs: trace.summary.maxCatchUpMs,
      },
      paints: trace.events
        .filter((event) => event.type === "paint")
        .map((event) => ({ tMs: event.tMs, mediaTimeMs: event.mediaTimeMs })),
    },
  };
})()`;

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

export { Invalid, STARVATION_NOTE };
