/* Depth under a dragging thumb: the Spring stereo clip, its depth layer on,
 * dragged along the timeline forwards and then backwards.
 *
 * A depth clip plays an 8-bit preview video decoded beside the picture, so a
 * drag asks that decoder to keep up with the hand. Each frame the picture
 * shows either has its depth drawn over it or has none; depth drawn for any
 * other frame is a correctness failure, never a trade-off. The scenarios count
 * the frames the screen showed without their depth and how long each frame
 * waited for it, which is what a person dragging sees as lag. */

import { delay } from "./cdp.mjs";
import { at, Hook, openControls } from "./hooks.mjs";
import { Invalid, waitForRenderer } from "./renderer-ready.mjs";
import { readFixtureButtons, selectFixture } from "./scenarios.mjs";
import { stable } from "./scenarios-guards.mjs";
import { percentile, round } from "./stats.mjs";

export const DEPTH_FIXTURE_ID = "spring_stereo_depth";
const DEPTH_READY_DEADLINE_MS = 30_000;
const DEPTH_DRAG_FORWARD = { from: 0.15, to: 0.85 };
const DEPTH_DRAG_BACKWARD = { from: 0.85, to: 0.15 };
const DEPTH_DRAG_STEPS = 90;
const DEPTH_DRAG_DURATION_MS = 1200;
const DEPTH_DRAG_TAIL_MS = 2500;
const DEPTH_DRAG_MIN_SAMPLES = 30;
/* Depth drawn for a frame other than the one on screen. The only right answer
 * is none: a stale map over new pixels puts depth beside what it measures. */
const DEPTH_WRONG_FRAME_LIMIT = 0;
/* Frames the screen showed during the drag and never drew depth over, as a
 * share of the frames it showed. With the session's playback gate on, a
 * frame waits for its depth instead, so this stays 0 and the cost shows in
 * the picture numbers below; it is the number that moves with the gate off. */
const DEPTH_FRAMES_WITHOUT_LIMIT = 0.25;
/* How long a frame waited on screen for its depth, p95 over the frames that
 * got it. A frame of a 24 fps clip lasts about 42ms. */
const DEPTH_LATENCY_P95_LIMIT_MS = 120;
/* How far the picture trailed the thumb, as the time the thumb took to cover
 * that distance. With depth removed the same drags read 54ms forwards and
 * 28ms backwards on average, 61ms and 34ms at p95; that is the engine's own
 * lag. Before depth followed drags, the backward drag read 72ms on average
 * and 179ms at p95, held one frame for 200ms and showed 30 frames a second:
 * the gate held each frame for a preview decode restarted at every move. */
const DEPTH_PICTURE_BEHIND_MEAN_LIMIT_MS = 100;
const DEPTH_PICTURE_BEHIND_P95_LIMIT_MS = 120;
const DEPTH_HOLD_MAX_LIMIT_MS = 100;
const DEPTH_FRAME_RATE_FLOOR = 40;
/* From letting go to depth over the frame the drag landed on. */
const DEPTH_RELEASE_LIMIT_MS = 400;

/* Runs before anything else reads the page's decoders, and counts how often
 * one is configured: the depth preview configures its decoder once per decode
 * run, so the count is how often a drag restarted it. The engine decodes in
 * its own worker and is not counted. */
const INSTALL_DEPTH_PROBE = `(() => {
  window.__depthDragProbe?.stop();
  const renderer = window.__demoRenderer;
  const clock = renderer?.frameClock;
  const input = document.querySelector(${at(Hook.TimelineInput)});
  if (!renderer || !clock || !input) return null;
  const Decoder = globalThis.VideoDecoder;
  if (Decoder && !Decoder.prototype.__depthEvalConfigure) {
    const configure = Decoder.prototype.configure;
    Decoder.prototype.__depthEvalConfigure = configure;
    Decoder.prototype.configure = function (config) {
      globalThis.__depthEvalConfigures = (globalThis.__depthEvalConfigures ?? 0) + 1;
      return configure.call(this, config);
    };
  }
  const box = input.getBoundingClientRect();
  const frameAt = (time) => (time === null || time === undefined ? null : clock.indexAtOrBefore(time + 0.0005));
  const state = { running: true, downAt: null, upAt: null, samples: [], configuresAtStart: globalThis.__depthEvalConfigures ?? 0 };
  const onDown = () => { state.downAt = performance.now(); };
  const onUp = () => { state.upAt = performance.now(); };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  const tick = () => {
    if (!state.running) return;
    const snapshot = renderer.getState();
    const active = renderer.getActiveDepth();
    state.samples.push({
      at: performance.now(),
      scrubValue: Number(input.value),
      presentedTime: snapshot.presentedTime ?? null,
      frame: frameAt(snapshot.presentedTime ?? null),
      depthFrame: active ? frameAt(active.mediaTime) : null,
      depthIndex: active ? active.frameIndex : null,
      precision: active ? active.precision : null,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__depthDragProbe = {
    stop() {
      state.running = false;
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      delete window.__depthDragProbe;
      return {
        ...state,
        configures: (globalThis.__depthEvalConfigures ?? 0) - state.configuresAtStart,
        visibility: document.visibilityState,
      };
    },
  };
  return { left: box.x, width: box.width, y: Math.round(box.y + box.height / 2) };
})()`;

/* Seeks, then waits for exact depth over the frame the seek landed on, so a
 * drag starts from rest with nothing of its own decoded yet. */
const SETTLE_DEPTH_AT = `(async (time, deadlineMs) => {
  const renderer = window.__demoRenderer;
  const clock = renderer.frameClock;
  const started = performance.now();
  renderer.pause();
  await renderer.seek(time);
  while (performance.now() - started < deadlineMs) {
    const state = renderer.getState();
    const active = renderer.getActiveDepth();
    const frame = state.presentedTime === null ? null : clock.indexAtOrBefore(state.presentedTime + 0.0005);
    if (active && active.precision === "exact" && active.frameIndex === frame) {
      return { settled: true, frame, settleMs: Math.round(performance.now() - started) };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { settled: false, settleMs: Math.round(performance.now() - started) };
})`;

async function dispatchMouse(session, type, x, y) {
  await session.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "mouse",
  });
}

/** A thumb dragging the depth clip's timeline forwards, then letting go. */
export async function runDepthDrag(session, info, attempts = 1) {
  return withDepthFixture(session, (fixture) =>
    stable(session, attempts, () =>
      measureDepthDrag(session, fixture, DEPTH_DRAG_FORWARD),
    ),
  );
}

/** The same drag backwards, which a forward-only decoder has to reach anew. */
export async function runDepthBackDrag(session, info, attempts = 1) {
  return withDepthFixture(session, (fixture) =>
    stable(session, attempts, () =>
      measureDepthDrag(session, fixture, DEPTH_DRAG_BACKWARD),
    ),
  );
}

/**
 * Opens the depth clip for the measurement and puts the clip the run met back
 * afterwards. Depth plays only on the web video engine path, so a run on
 * Mediabunny has nothing to measure and says so.
 */
async function withDepthFixture(session, measure) {
  await session.send("Page.bringToFront");
  const opening = await readFixtureButtons(session);
  const pressed = opening.find((button) => button.pressed);
  if (!opening.some((button) => button.id === DEPTH_FIXTURE_ID)) {
    throw new Invalid(
      `the demo is not offering the depth clip "${DEPTH_FIXTURE_ID}"; it has ` +
        `${opening.map((button) => `"${button.id}"`).join(", ")}`,
    );
  }
  try {
    const fixture = await selectFixture(session, DEPTH_FIXTURE_ID);
    await openControls(session);
    return await measure(fixture);
  } finally {
    if (pressed && pressed.id !== DEPTH_FIXTURE_ID) {
      await selectFixture(session, pressed.id).catch(() => {});
    }
    await openControls(session).catch(() => {});
  }
}

async function measureDepthDrag(session, fixture, direction) {
  await waitForRenderer(session);
  const visibility = await session.evaluate("document.visibilityState");
  if (visibility !== "visible") {
    throw new Invalid(`the demo tab was ${visibility}`);
  }
  const mediaPath = await session.evaluate(
    `document.querySelector(${at(Hook.Shell)})?.getAttribute("data-eval-media-path") ?? null`,
  );
  const start = round(fixture.duration * direction.from, 3);
  const settled = await session.readJson(
    `(${SETTLE_DEPTH_AT})(${start}, ${DEPTH_READY_DEADLINE_MS})`,
  );
  if (!settled.settled) {
    throw new Invalid(
      `exact depth never drew over the frame at ${start}s within ` +
        `${DEPTH_READY_DEADLINE_MS}ms on the ${mediaPath ?? "unnamed"} path; ` +
        "depth clips play on the web video engine, so pass ?mediaPath=engine",
    );
  }
  await delay(300);

  const geometry = await session.readJson(INSTALL_DEPTH_PROBE);
  if (geometry === null) {
    throw new Invalid(
      "the demo is not showing the timeline input, or its renderer has no frame clock",
    );
  }
  const fromX = geometry.left + geometry.width * direction.from;
  const toX = geometry.left + geometry.width * direction.to;
  let probe;
  try {
    await dispatchMouse(session, "mousePressed", fromX, geometry.y);
    const startedAt = Date.now();
    for (let step = 1; step <= DEPTH_DRAG_STEPS; step += 1) {
      const x = fromX + ((toX - fromX) * step) / DEPTH_DRAG_STEPS;
      await dispatchMouse(session, "mouseMoved", x, geometry.y);
      const owed =
        startedAt +
        (DEPTH_DRAG_DURATION_MS * step) / DEPTH_DRAG_STEPS -
        Date.now();
      if (owed > 0) await delay(owed);
    }
    await dispatchMouse(session, "mouseReleased", toX, geometry.y);
    await delay(DEPTH_DRAG_TAIL_MS);
  } finally {
    probe = await session
      .readJson("window.__depthDragProbe?.stop() ?? null")
      .catch(() => null);
  }
  if (probe === null) {
    throw new Invalid("the depth probe was torn down before the drag ended");
  }
  if (probe.visibility !== "visible") {
    throw new Invalid(`the demo tab was ${probe.visibility} during the drag`);
  }
  if (probe.downAt === null || probe.upAt === null) {
    throw new Invalid(
      "the synthesised pointer never reached the timeline; the input moved or is covered",
    );
  }

  const scenario = {
    direction: direction.to > direction.from ? "forward" : "backward",
    ...summariseDepthDrag(probe),
  };
  return { scenario, failures: judgeDepthDrag(scenario) };
}

/**
 * Reduces one recorded drag to what a person sees of depth: how many of the
 * frames the screen showed never drew their depth, how long the ones that did
 * waited for it, and how long after letting go the frame the drag landed on
 * drew its depth, then its exact depth.
 *
 * A frame is counted once per stay on screen: the samples from the moment the
 * picture changed to it until the moment it changed again.
 */
export function summariseDepthDrag(probe) {
  const during = probe.samples.filter(
    (sample) =>
      sample.at >= probe.downAt &&
      sample.at <= probe.upAt &&
      sample.frame !== null,
  );
  if (during.length < DEPTH_DRAG_MIN_SAMPLES) {
    throw new Invalid(
      `requestAnimationFrame delivered ${during.length} samples across the drag ` +
        `(needs ${DEPTH_DRAG_MIN_SAMPLES}); the compositor is not running`,
    );
  }

  const stays = [];
  for (const sample of during) {
    const current = stays.at(-1);
    if (!current || current.frame !== sample.frame) {
      stays.push({ frame: sample.frame, startedAt: sample.at, depthAt: null });
    }
    const stay = stays.at(-1);
    if (stay.depthAt === null && sample.depthFrame === sample.frame) {
      stay.depthAt = sample.at;
    }
  }
  const withDepth = stays.filter((stay) => stay.depthAt !== null);
  const latencies = withDepth.map((stay) => stay.depthAt - stay.startedAt);
  const wrongFrameSamples = probe.samples.filter(
    (sample) =>
      sample.frame !== null &&
      sample.depthFrame !== null &&
      sample.depthFrame !== sample.frame,
  ).length;
  const withoutSamples = during.filter(
    (sample) => sample.depthFrame !== sample.frame,
  ).length;

  const after = probe.samples.filter((sample) => sample.at > probe.upAt);
  const landedFrame = after.at(-1)?.frame ?? null;
  const firstDepth = after.find(
    (sample) =>
      sample.frame === landedFrame && sample.depthFrame === landedFrame,
  );
  const firstExact = after.find(
    (sample) =>
      sample.frame === landedFrame &&
      sample.depthFrame === landedFrame &&
      sample.precision === "exact",
  );
  const frames = new Set(during.map((sample) => sample.frame));
  const dragSeconds = (probe.upAt - probe.downAt) / 1000;
  /* Media seconds the thumb covered per wall second, read off the input it was
   * dragging: it turns how far the picture is behind the thumb into how long
   * it has been out of date. */
  const scrubRate =
    Math.abs(during.at(-1).scrubValue - during[0].scrubValue) / dragSeconds;
  if (!(scrubRate > 0)) {
    throw new Invalid(
      "the timeline input never moved across the drag; the pointer missed it",
    );
  }
  const behindMs = during.map(
    (sample) =>
      (Math.abs(sample.scrubValue - sample.presentedTime) / scrubRate) * 1000,
  );
  const holds = stays.map(
    (stay, index) =>
      (stays[index + 1]?.startedAt ?? during.at(-1).at) - stay.startedAt,
  );

  return {
    dragSeconds: round(dragSeconds, 2),
    samples: during.length,
    scrubRatePerSecond: round(scrubRate, 2),
    pictureBehindMeanMs: round(
      behindMs.reduce((sum, value) => sum + value, 0) / behindMs.length,
      1,
    ),
    pictureBehindP95Ms: percentile(behindMs, 0.95, 1),
    holdMaxMs: round(Math.max(...holds), 1),
    framesPerSecond: round(stays.length / dragSeconds, 1),
    distinctFrames: frames.size,
    framesShown: stays.length,
    framesWithoutDepth: stays.length - withDepth.length,
    framesWithoutDepthShare: round(
      (stays.length - withDepth.length) / stays.length,
      3,
    ),
    samplesWithoutDepthShare: round(withoutSamples / during.length, 3),
    depthLatencyP50Ms: percentile(latencies, 0.5, 1),
    depthLatencyP95Ms: percentile(latencies, 0.95, 1),
    depthLatencyMaxMs:
      latencies.length === 0 ? null : round(Math.max(...latencies), 1),
    wrongFrameSamples,
    decoderRestarts: probe.configures,
    releaseFrame: landedFrame,
    releaseToDepthMs:
      firstDepth === undefined ? null : Math.round(firstDepth.at - probe.upAt),
    releaseToExactMs:
      firstExact === undefined ? null : Math.round(firstExact.at - probe.upAt),
    limits: {
      pictureBehindMeanMs: DEPTH_PICTURE_BEHIND_MEAN_LIMIT_MS,
      pictureBehindP95Ms: DEPTH_PICTURE_BEHIND_P95_LIMIT_MS,
      holdMaxMs: DEPTH_HOLD_MAX_LIMIT_MS,
      framesPerSecond: DEPTH_FRAME_RATE_FLOOR,
      framesWithoutDepthShare: DEPTH_FRAMES_WITHOUT_LIMIT,
      depthLatencyP95Ms: DEPTH_LATENCY_P95_LIMIT_MS,
      releaseToDepthMs: DEPTH_RELEASE_LIMIT_MS,
      wrongFrameSamples: DEPTH_WRONG_FRAME_LIMIT,
    },
  };
}

export function judgeDepthDrag(scenario) {
  const name =
    scenario.direction === "backward" ? "depth-backdrag" : "depth-drag";
  const failures = [];
  if (scenario.wrongFrameSamples > DEPTH_WRONG_FRAME_LIMIT) {
    failures.push(
      `${name}: depth for another frame was drawn on ${scenario.wrongFrameSamples} ` +
        "samples; depth must be the frame on screen's or none",
    );
  }
  if (scenario.pictureBehindMeanMs > DEPTH_PICTURE_BEHIND_MEAN_LIMIT_MS) {
    failures.push(
      `${name}: the picture trailed the thumb by ${scenario.pictureBehindMeanMs}ms ` +
        `on average (limit ${DEPTH_PICTURE_BEHIND_MEAN_LIMIT_MS}ms)`,
    );
  }
  if (scenario.pictureBehindP95Ms > DEPTH_PICTURE_BEHIND_P95_LIMIT_MS) {
    failures.push(
      `${name}: the picture trailed the thumb by ${scenario.pictureBehindP95Ms}ms ` +
        `at p95 (limit ${DEPTH_PICTURE_BEHIND_P95_LIMIT_MS}ms)`,
    );
  }
  if (scenario.holdMaxMs > DEPTH_HOLD_MAX_LIMIT_MS) {
    failures.push(
      `${name}: the screen held one frame for ${scenario.holdMaxMs}ms while the ` +
        `thumb kept moving (limit ${DEPTH_HOLD_MAX_LIMIT_MS}ms)`,
    );
  }
  if (scenario.framesPerSecond < DEPTH_FRAME_RATE_FLOOR) {
    failures.push(
      `${name}: only ${scenario.framesPerSecond} frames a second reached the ` +
        `screen (floor ${DEPTH_FRAME_RATE_FLOOR}/s)`,
    );
  }
  if (scenario.framesWithoutDepthShare > DEPTH_FRAMES_WITHOUT_LIMIT) {
    failures.push(
      `${name}: ${scenario.framesWithoutDepth} of ${scenario.framesShown} frames on ` +
        `screen never drew their depth (${scenario.framesWithoutDepthShare}, limit ` +
        `${DEPTH_FRAMES_WITHOUT_LIMIT})`,
    );
  }
  if (
    scenario.depthLatencyP95Ms !== null &&
    scenario.depthLatencyP95Ms > DEPTH_LATENCY_P95_LIMIT_MS
  ) {
    failures.push(
      `${name}: frames waited ${scenario.depthLatencyP95Ms}ms for their depth at ` +
        `p95 (limit ${DEPTH_LATENCY_P95_LIMIT_MS}ms)`,
    );
  }
  if (scenario.releaseToDepthMs === null) {
    failures.push(
      `${name}: the frame the drag landed on never drew depth within ` +
        `${DEPTH_DRAG_TAIL_MS}ms of letting go`,
    );
  } else if (scenario.releaseToDepthMs > DEPTH_RELEASE_LIMIT_MS) {
    failures.push(
      `${name}: depth took ${scenario.releaseToDepthMs}ms to draw over the frame ` +
        `the drag landed on (limit ${DEPTH_RELEASE_LIMIT_MS}ms)`,
    );
  }
  return failures;
}

export function depthDetail(scenario, field) {
  return [
    field(
      "picture behind thumb",
      `${scenario.pictureBehindMeanMs}ms mean, ${scenario.pictureBehindP95Ms}ms p95 ` +
        `at ${scenario.scrubRatePerSecond}x  (limits ${scenario.limits.pictureBehindMeanMs} / ` +
        `${scenario.limits.pictureBehindP95Ms}ms)`,
    ),
    field(
      "frames reaching screen",
      `${scenario.framesShown} = ${scenario.framesPerSecond}/s  (floor ` +
        `${scenario.limits.framesPerSecond}/s)`,
    ),
    field(
      "longest hold",
      `${scenario.holdMaxMs}ms  (limit ${scenario.limits.holdMaxMs}ms)`,
    ),
    field(
      "frames without depth",
      `${scenario.framesWithoutDepth} of ${scenario.framesShown} = ` +
        `${scenario.framesWithoutDepthShare}  (limit ${scenario.limits.framesWithoutDepthShare})`,
    ),
    field(
      "samples without depth",
      `${scenario.samplesWithoutDepthShare} of ${scenario.samples}`,
    ),
    field(
      "depth latency p50 / p95 / max",
      `${scenario.depthLatencyP50Ms} / ${scenario.depthLatencyP95Ms} / ` +
        `${scenario.depthLatencyMaxMs} ms  (limit ${scenario.limits.depthLatencyP95Ms})`,
    ),
    field("depth for another frame", `${scenario.wrongFrameSamples} samples`),
    field("preview decoder restarts", `${scenario.decoderRestarts}`),
    field(
      "release to depth / exact",
      `${scenario.releaseToDepthMs ?? "never"} / ${scenario.releaseToExactMs ?? "never"} ms` +
        `  (limit ${scenario.limits.releaseToDepthMs})`,
    ),
  ];
}
