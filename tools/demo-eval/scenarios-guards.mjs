/* One scenario per defect a person reported watching this player.
 *
 * Every scenario here exists because the thing it measures shipped broken once:
 * annotations blanking mid-playback, a drag that never let go, a playhead that
 * kept running while the picture stood still, masks that only arrived when the
 * scrub went forwards, a focus overlay that vanished instead of cutting out,
 * and shortcuts that died the moment a checkbox took focus. Each one drives the
 * page the way a hand does and reports a number, so the same defect cannot come
 * back quietly.
 */

import { delay } from "./cdp.mjs";

const BLANKING_SEEK_SECONDS = 3;
const BLANKING_SETTLE_MS = 1500;
const BLANKING_SAMPLE_MS = 10_000;
const BLANKING_INTERVAL_MS = 100;
const BLANKING_MIN_SAMPLES = 60;
/* Read-ahead is what keeps a drawn frame carrying its detections. Below this
 * the picture is outrunning the cook and the boxes start blinking out. */
const PREPARED_AHEAD_FLOOR = 30;
const NULL_DETECTION_LIMIT = 0.01;
const UNPREPARED_LIMIT = 0.05;

const DRAG_START_FRACTION = 0.15;
const DRAG_END_FRACTION = 0.85;
const DRAG_STEPS = 90;
/* The gesture is paced by the wall clock rather than by however fast the
 * protocol happens to deliver pointer moves that minute: ninety moves in
 * 1200ms is 75Hz, near a real thumb, and it is the same gesture on a machine
 * where a dispatched move costs 5ms and one where it costs 30ms. Unpaced, the
 * same drag ran anywhere from 0.48s to 1.15s and the numbers moved with it. */
const DRAG_DURATION_MS = 1200;
const DRAG_TAIL_MS = 2500;
const DRAG_MIN_SAMPLES = 30;
/* Measured on an M3 Max against the 70s horse fixture after the
 * decode-scheduler fix: hold p95 65ms to 222ms with a worst single hold of
 * 542ms, 15 to 57 frames a second reaching the screen, release landing in 1ms
 * to 9ms. The wide end of each of those is the one pass in three this machine
 * disturbs; the baseline records the median of three, which drops it.
 *
 * Lag is the exception: across fourteen runs of the identical gesture its p95
 * came out 0.03s on eight of them and 0.12s, 1.67s, 2.80s, 3.42s and 7.32s on
 * the rest. Either the picture keeps up for most of the drag or it spends most
 * of it catching up, and no threshold inside a spread that wide means
 * anything. So the cliff clears every run measured and catches only a
 * catastrophe, and the baseline's median of three passes is what actually
 * watches this number. Closing the spread itself is open work: it is the
 * scrub-smoothness difference against the FrameSampler story. */
const DRAG_LAG_P95_LIMIT_SECONDS = 10;
/* The longest the screen may hold one frame while the thumb keeps moving. The
 * p95 is the number that describes the gesture; the max exists so a genuine
 * freeze cannot hide behind a healthy p95. */
const DRAG_HOLD_P95_LIMIT_MS = 300;
const DRAG_HOLD_MAX_LIMIT_MS = 900;
const DRAG_FRAME_RATE_FLOOR = 10;
const DRAG_RELEASE_LIMIT_MS = 500;
const RESUME_PROBE_MS = 900;
const RESUME_MIN_ADVANCE_SECONDS = 0.15;

const PLAYHEAD_SEEK_SECONDS = 20;
const PLAYHEAD_HOLD_MS = 4000;
const PLAYHEAD_INTERVAL_MS = 100;
/* The playhead writer quantizes to half a rendered pixel, so a stopped picture
 * may leave it one quantum away from where it was and no further. */
const PLAYHEAD_DRIFT_LIMIT_PERCENT = 0.2;
const PLAYHEAD_DISAGREEMENT_LIMIT_PERCENT = 1;
const PLAYHEAD_FIT_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

const SCRUB_STOP_FRACTIONS = [0.25, 0.4, 0.55, 0.7, 0.85];
const SCRUB_SETTLE_DEADLINE_MS = 4000;
/* Backward stops carrying less than this share of the ink their forward twins
 * carried are missing masks, which is the defect this measures. Measured at
 * exactly 1.000 at all five stops across runs, because both passes photograph
 * the same paused frame; turning masks off drops the same frames to 0.50 to
 * 0.75 of their ink, so the floor sits between the two with room on each side. */
const MASK_INK_RATIO_FLOOR = 0.9;

const FOCUS_SEEK_SECONDS = 12;
/* Focus dims the scene around its subjects. Adding less than this much dark is
 * an overlay that never drew; leaving less than the cutout floor bright is an
 * overlay that drew over everything, including the subject it exists to show. */
const FOCUS_DIM_DELTA_FLOOR = 0.02;
const FOCUS_CUTOUT_FLOOR = 0.02;

const HOTKEY_STEP_TOLERANCE_FRAMES = 1.5;
const HOTKEY_SKIP_SECONDS = 1;
const HOTKEY_SETTLE_MS = 400;

class Invalid extends Error {}

const VISIBILITY = `document.visibilityState`;

async function focusPage(session) {
  await session.send("Page.bringToFront");
  await waitForRenderer(session);
  const visibility = await session.evaluate(VISIBILITY);
  if (visibility !== "visible") {
    throw new Invalid(
      `the demo tab was ${visibility}; a hidden tab parks requestAnimationFrame ` +
        "and every number taken from it is a measurement of nothing",
    );
  }
}

async function waitForRenderer(session, timeoutMs = 60_000) {
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
      return { ready: true };
    })()`);
    if (last.ready) return;
    await delay(500);
  }
  throw new Invalid(
    `the demo renderer never became ready: ${last?.reason ?? "no response"}`,
  );
}

/* A dev-server hot patch remounts the app mid-scenario, and every call still
 * holding the old renderer throws "Media renderer has been destroyed". That is
 * the harness being disturbed, not the player misbehaving, so the attempt is
 * discarded and taken again rather than reported as a defect. */
const DISTURBED =
  /Media renderer has been destroyed|__demoRenderer is (absent|undefined)|Cannot read properties of undefined/i;

export async function stable(session, attempts, run) {
  let last = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const navMark = session.navigations;
    const patchMark = session.devServerPatches;
    try {
      const result = await run();
      if (
        session.navigations === navMark &&
        session.devServerPatches === patchMark
      ) {
        return result;
      }
      last = "the dev server hot-patched the app while the window was open";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!DISTURBED.test(message)) throw error;
      last = message;
    }
    await waitForRenderer(session);
  }
  throw new Invalid(
    `${attempts} attempts were all disturbed; the last said: ${last}`,
  );
}

const SETTLE_AT = `(async (time, deadlineMs) => {
  const renderer = window.__demoRenderer;
  const started = performance.now();
  const rendersBefore = renderer.getRenderCount();
  await renderer.seek(time);
  const framePeriod = 1 / (renderer.getState().source.estimatedFrameRate || 30);
  while (performance.now() - started < deadlineMs) {
    const state = renderer.getState();
    const prepared = renderer.getPreparedAnnotationWindow();
    const active = prepared?.frames.find(
      (frame) => Math.abs(frame.mediaTime - state.currentTime) <= framePeriod / 2,
    );
    const detectionReady =
      state.activeDetectionFrameTime !== null &&
      Math.abs(state.activeDetectionFrameTime - state.currentTime) <= framePeriod;
    // The masks being cooked is not the masks being on screen. A screenshot
    // taken between the two reads as a frame that lost its masks.
    const drawn = renderer.getRenderCount() > rendersBefore;
    if (detectionReady && active?.prepared && drawn) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return {
        settleMs: Math.round(performance.now() - started),
        currentTime: state.currentTime,
        detectionTime: state.activeDetectionFrameTime,
        detectionCount: state.activeDetectionCount,
        prepared: true,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  const state = renderer.getState();
  return {
    settleMs: Math.round(performance.now() - started),
    currentTime: state.currentTime,
    detectionTime: state.activeDetectionFrameTime,
    detectionCount: state.activeDetectionCount,
    prepared: false,
  };
})`;

/**
 * Reduces one screenshot to the three things a broken layer shows up in: how
 * much of the picture is dark, how much of it carries coloured ink, and the
 * per-pixel luminance itself, kept so two shots of the same frame can be
 * compared pixel for pixel.
 */
const READ_INK = `(async (dataUrl, sampleWidth, withLuminance) => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, sampleWidth / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const luminance = new Uint8Array(width * height);
  let dark = 0;
  let coloured = 0;
  let total = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    const r = data[at];
    const g = data[at + 1];
    const b = data[at + 2];
    const value = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    luminance[pixel] = value;
    total += value;
    if (value < 60) dark += 1;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    if (high - low > 40 && high > 60) coloured += 1;
  }
  return {
    width,
    height,
    meanLuminance: Math.round(total / (width * height)),
    darkFraction: Number((dark / (width * height)).toFixed(4)),
    colouredFraction: Number((coloured / (width * height)).toFixed(4)),
    luminance: withLuminance ? Array.from(luminance) : null,
  };
})`;

const INK_SAMPLE_WIDTH = 200;

async function readInk(session, geometry, { withLuminance = false } = {}) {
  const box = geometry.canvasBox;
  if (!box) throw new Invalid("the demo is not showing a canvas to measure");
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
  });
  return session.readJson(
    `(${READ_INK})("data:image/png;base64,${data}", ${INK_SAMPLE_WIDTH}, ${withLuminance})`,
  );
}

/* ---------------------------------------------------------------- blanking */

const BLANKING_SAMPLER = `(async () => {
  const renderer = window.__demoRenderer;
  const samples = [];
  const read = () => {
    const state = renderer.getState();
    const prepared = renderer.getPreparedAnnotationWindow();
    const framePeriod = 1 / (state.source.estimatedFrameRate || 30);
    let preparedAhead = 0;
    let activePrepared = null;
    if (prepared) {
      const frames = prepared.frames;
      let index = 0;
      while (index < frames.length && frames[index].mediaTime < state.currentTime) index += 1;
      const active = frames[Math.max(0, index - 1)];
      if (active && Math.abs(active.mediaTime - state.currentTime) <= framePeriod) {
        activePrepared = active.prepared;
      }
      let running = true;
      for (let at = index; at < frames.length && running; at += 1) {
        if (frames[at].prepared) preparedAhead += 1;
        else running = false;
      }
    }
    samples.push({
      at: performance.now(),
      currentTime: state.currentTime,
      playbackState: state.playbackState,
      detectionTime: state.activeDetectionFrameTime,
      detectionCount: state.activeDetectionCount,
      renderCount: renderer.getRenderCount(),
      preparedAhead,
      activePrepared,
    });
  };
  read();
  const timer = setInterval(read, ${BLANKING_INTERVAL_MS});
  await new Promise((resolve) => setTimeout(resolve, ${BLANKING_SAMPLE_MS}));
  clearInterval(timer);
  read();
  return { samples, visibility: document.visibilityState };
})()`;

/**
 * Playback with the annotations watched rather than the picture. The defect
 * this replaces: detections went missing every ten seconds or so because the
 * buffer only reloaded once the playhead had already left the window it was
 * drawing from, and the mask cook never got far enough ahead to cover the gap.
 */
export async function runBlanking(session, info, attempts = 1) {
  return stable(session, attempts, () => measureBlanking(session));
}

async function measureBlanking(session) {
  await focusPage(session);
  await session.evaluate(
    `(async () => {
      const renderer = window.__demoRenderer;
      await renderer.seek(${BLANKING_SEEK_SECONDS});
      await renderer.play();
    })()`,
  );
  await delay(BLANKING_SETTLE_MS);
  const raw = await session.readJson(BLANKING_SAMPLER);
  await session.evaluate("window.__demoRenderer.pause(); 1").catch(() => {});

  if (raw.visibility !== "visible") {
    throw new Invalid(`the demo tab was ${raw.visibility} during the window`);
  }
  const { samples } = raw;
  if (samples.length < BLANKING_MIN_SAMPLES) {
    throw new Invalid(
      `the sampler collected ${samples.length} of the ${BLANKING_MIN_SAMPLES} ` +
        "readings the window owes; the page was starved of the main thread",
    );
  }
  const first = samples[0];
  const last = samples.at(-1);
  const wallSeconds = (last.at - first.at) / 1000;
  const mediaSeconds = last.currentTime - first.currentTime;
  if (mediaSeconds <= 0 && last.renderCount === first.renderCount) {
    throw new Invalid(
      "decoder starvation: the media clock froze and nothing rendered; another " +
        "tab is holding the hardware decoder sessions",
    );
  }

  const scenario = {
    ...summariseBlanking(samples),
    seekSeconds: BLANKING_SEEK_SECONDS,
    sampleMs: BLANKING_SAMPLE_MS,
    wallSeconds: round(wallSeconds, 2),
    mediaSeconds: round(mediaSeconds, 2),
  };
  return { scenario, failures: judgeBlanking(scenario) };
}

export function summariseBlanking(samples) {
  const preparedAhead = samples.map((sample) => sample.preparedAhead);
  const count = (predicate) => samples.filter(predicate).length;
  return {
    samples: samples.length,
    preparedAheadMedian: percentile(preparedAhead, 0.5),
    preparedAheadMin: Math.min(...preparedAhead),
    nullDetectionFraction: round(
      count((sample) => sample.detectionTime === null) / samples.length,
      4,
    ),
    emptyDetectionFraction: round(
      count((sample) => sample.detectionCount === 0) / samples.length,
      4,
    ),
    unpreparedFraction: round(
      count((sample) => sample.activePrepared === false) / samples.length,
      4,
    ),
    floors: {
      preparedAhead: PREPARED_AHEAD_FLOOR,
      nullDetectionFraction: NULL_DETECTION_LIMIT,
      unpreparedFraction: UNPREPARED_LIMIT,
    },
  };
}

export function judgeBlanking(scenario) {
  const failures = [];
  if (scenario.preparedAheadMedian < PREPARED_AHEAD_FLOOR) {
    failures.push(
      `blanking: the cook sat ${scenario.preparedAheadMedian} frames ahead of the ` +
        `playhead, under the ${PREPARED_AHEAD_FLOOR}-frame floor`,
    );
  }
  if (scenario.nullDetectionFraction > NULL_DETECTION_LIMIT) {
    failures.push(
      `blanking: ${scenario.nullDetectionFraction} of sampled frames drew no ` +
        `detection at all (limit ${NULL_DETECTION_LIMIT})`,
    );
  }
  if (scenario.unpreparedFraction > UNPREPARED_LIMIT) {
    failures.push(
      `blanking: ${scenario.unpreparedFraction} of sampled frames were on screen ` +
        `before their masks were cooked (limit ${UNPREPARED_LIMIT})`,
    );
  }
  return failures;
}

/* -------------------------------------------------------------------- drag */

/* A probe left running keeps a requestAnimationFrame loop reading the renderer
 * every frame, which lands in whatever scenario runs next. */
const INSTALL_DRAG_PROBE = `(() => {
  window.__dragProbe?.stop();
  const renderer = window.__demoRenderer;
  const input = document.querySelector("input.timeline-view__input");
  if (!input) return null;
  const box = input.getBoundingClientRect();
  const state = {
    running: true,
    pointerX: null,
    downAt: null,
    upAt: null,
    samples: [],
  };
  const onDown = (event) => {
    state.downAt = performance.now();
    state.pointerX = event.clientX;
  };
  const onMove = (event) => {
    state.pointerX = event.clientX;
  };
  const onUp = () => {
    state.upAt = performance.now();
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  const tick = () => {
    if (!state.running) return;
    const snapshot = renderer.getState();
    state.samples.push({
      at: performance.now(),
      pointerX: state.pointerX,
      scrubValue: Number(input.value),
      currentTime: snapshot.currentTime,
      playbackState: snapshot.playbackState,
      renderCount: renderer.getRenderCount(),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__dragProbe = {
    stop() {
      state.running = false;
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      delete window.__dragProbe;
      return { ...state, visibility: document.visibilityState };
    },
  };
  return {
    left: box.x,
    width: box.width,
    y: Math.round(box.y + box.height / 2),
  };
})()`;

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

/**
 * A thumb dragging the timeline from end to end, then letting go.
 *
 * Four separate defects lived in this one gesture: the picture fell seconds
 * behind the thumb because every decode that finished after the next pointer
 * move was thrown away; the screen held one frame for tenths of a second at a
 * time; the release never reached the producer, which left the engine
 * mechanically paused while the chip still read Playing; and the state the
 * transport reported during the drag was not the state it was in.
 */
export async function runDrag(session, info, attempts = 1) {
  return stable(session, attempts, () => measureDrag(session, info));
}

async function measureDrag(session, info) {
  await focusPage(session);
  await session.evaluate("window.__demoRenderer.pause(); 1");
  const duration = info.duration;
  const start = round(duration * DRAG_START_FRACTION, 3);
  await session.readJson(
    `(${SETTLE_AT})(${start}, ${SCRUB_SETTLE_DEADLINE_MS})`,
  );
  await session.readJson(
    `(${AWAIT_STILL})(${STILL_DEADLINE_MS}, ${STILL_QUIET_POLLS})`,
  );
  const before = await session.readJson(
    `(() => { const s = window.__demoRenderer.getState(); return { playbackState: s.playbackState, currentTime: s.currentTime }; })()`,
  );

  const geometry = await session.readJson(INSTALL_DRAG_PROBE);
  if (geometry === null) {
    throw new Invalid(
      "the demo is not showing the timeline input; the control bar changed or never mounted",
    );
  }

  const fromX = geometry.left + geometry.width * DRAG_START_FRACTION;
  const toX = geometry.left + geometry.width * DRAG_END_FRACTION;
  let probe;
  try {
    await dispatchMouse(session, "mousePressed", fromX, geometry.y);
    const startedAt = Date.now();
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      const x = fromX + ((toX - fromX) * step) / DRAG_STEPS;
      await dispatchMouse(session, "mouseMoved", x, geometry.y);
      const owed =
        startedAt + (DRAG_DURATION_MS * step) / DRAG_STEPS - Date.now();
      if (owed > 0) await delay(owed);
    }
    await dispatchMouse(session, "mouseReleased", toX, geometry.y);
    await delay(DRAG_TAIL_MS);
  } finally {
    probe = await session
      .readJson("window.__dragProbe?.stop() ?? null")
      .catch(() => null);
  }
  if (probe === null) {
    throw new Invalid("the drag probe was torn down before the drag ended");
  }

  if (probe.visibility !== "visible") {
    throw new Invalid(`the demo tab was ${probe.visibility} during the drag`);
  }
  if (probe.downAt === null || probe.upAt === null) {
    throw new Invalid(
      "the synthesised pointer never reached the timeline; the input moved or is covered",
    );
  }

  const summary = summariseDrag(probe, {
    frameRate: info.frameRate,
    startedPaused: before.playbackState !== "playing",
  });

  const resumeAfterRelease = await session.readJson(
    `(async () => {
      const renderer = window.__demoRenderer;
      const before = renderer.getState().currentTime;
      const renders = renderer.getRenderCount();
      await renderer.play();
      await new Promise((resolve) => setTimeout(resolve, ${RESUME_PROBE_MS}));
      const state = renderer.getState();
      const advanced = state.currentTime - before;
      renderer.pause();
      return {
        advancedSeconds: Number(advanced.toFixed(3)),
        renderDelta: renderer.getRenderCount() - renders,
        playbackState: state.playbackState,
      };
    })()`,
  );

  const scenario = { ...summary, steps: DRAG_STEPS, resumeAfterRelease };
  return { scenario, failures: judgeDrag(scenario) };
}

/**
 * Turns one recorded drag into the four numbers the gesture is judged on: how
 * far the picture trailed the thumb, the longest it held a single frame, how
 * many frames reached the screen, and how long the release took to land.
 *
 * The position the thumb is at is read from the timeline input rather than
 * derived from the pointer's pixel: a range input maps its track through a
 * half-thumb inset at each end, so a pixel converted to a time by hand is
 * wrong by most of a second near the ends, which is where a drag spends its
 * fastest moments.
 */
export function summariseDrag(probe, { frameRate, startedPaused }) {
  const during = probe.samples.filter(
    (sample) =>
      sample.at >= probe.downAt &&
      sample.at <= probe.upAt &&
      sample.pointerX !== null,
  );
  if (during.length < DRAG_MIN_SAMPLES) {
    throw new Invalid(
      `requestAnimationFrame delivered ${during.length} samples across the drag ` +
        `(needs ${DRAG_MIN_SAMPLES}); the compositor is not running`,
    );
  }

  const lags = during.map((sample) =>
    Math.abs(sample.scrubValue - sample.currentTime),
  );
  const dragSeconds = (probe.upAt - probe.downAt) / 1000;
  const framesPresented = during.at(-1).renderCount - during[0].renderCount;

  const holds = [];
  let lastChangeAt = during[0].at;
  let lastCount = during[0].renderCount;
  for (const sample of during) {
    if (sample.renderCount === lastCount) continue;
    holds.push(sample.at - lastChangeAt);
    lastChangeAt = sample.at;
    lastCount = sample.renderCount;
  }
  holds.push(during.at(-1).at - lastChangeAt);

  const releaseTarget = during.at(-1).scrubValue;
  const framePeriod = 1 / (frameRate || 30);
  const after = probe.samples.filter((sample) => sample.at > probe.upAt);
  const landed = after.find(
    (sample) => Math.abs(sample.currentTime - releaseTarget) <= framePeriod * 2,
  );

  return {
    dragSeconds: round(dragSeconds, 2),
    pacedSeconds: DRAG_DURATION_MS / 1000,
    scrubbedFromSeconds: round(during[0].scrubValue, 3),
    samples: during.length,
    startedPaused,
    lagMeanSeconds: round(mean(lags), 3),
    lagP95Seconds: percentile(lags, 0.95),
    lagMaxSeconds: round(Math.max(...lags), 3),
    holdP95Ms: percentile(holds, 0.95),
    holdMaxMs: round(Math.max(...holds), 1),
    framesPresented,
    framesPerSecond: round(framesPresented / dragSeconds, 2),
    releaseTargetSeconds: round(releaseTarget, 3),
    releaseMs: landed === undefined ? null : Math.round(landed.at - probe.upAt),
    settledPlaybackState: after.at(-1)?.playbackState ?? null,
    misreportedStateSamples: startedPaused
      ? during.filter((sample) => sample.playbackState === "playing").length
      : 0,
    limits: {
      lagP95Seconds: DRAG_LAG_P95_LIMIT_SECONDS,
      holdP95Ms: DRAG_HOLD_P95_LIMIT_MS,
      holdMaxMs: DRAG_HOLD_MAX_LIMIT_MS,
      framesPerSecond: DRAG_FRAME_RATE_FLOOR,
      releaseMs: DRAG_RELEASE_LIMIT_MS,
    },
  };
}

export function judgeDrag(scenario) {
  const failures = [];
  if (scenario.lagP95Seconds > DRAG_LAG_P95_LIMIT_SECONDS) {
    failures.push(
      `drag: the picture sat ${scenario.lagP95Seconds}s behind the thumb at p95 ` +
        `(limit ${DRAG_LAG_P95_LIMIT_SECONDS}s)`,
    );
  }
  if (scenario.holdP95Ms > DRAG_HOLD_P95_LIMIT_MS) {
    failures.push(
      `drag: the screen held one frame for ${scenario.holdP95Ms}ms at p95 while the ` +
        `thumb kept moving (limit ${DRAG_HOLD_P95_LIMIT_MS}ms)`,
    );
  }
  if (scenario.holdMaxMs > DRAG_HOLD_MAX_LIMIT_MS) {
    failures.push(
      `drag: the screen froze on one frame for ${scenario.holdMaxMs}ms mid-drag ` +
        `(limit ${DRAG_HOLD_MAX_LIMIT_MS}ms)`,
    );
  }
  if (scenario.framesPerSecond < DRAG_FRAME_RATE_FLOOR) {
    failures.push(
      `drag: only ${scenario.framesPerSecond} frames a second reached the screen ` +
        `(floor ${DRAG_FRAME_RATE_FLOOR}/s)`,
    );
  }
  if (scenario.releaseMs === null) {
    failures.push(
      `drag: the release never landed on ${scenario.releaseTargetSeconds}s within ` +
        `${DRAG_TAIL_MS}ms; the gesture did not end`,
    );
  } else if (scenario.releaseMs > DRAG_RELEASE_LIMIT_MS) {
    failures.push(
      `drag: the release took ${scenario.releaseMs}ms to land ` +
        `(limit ${DRAG_RELEASE_LIMIT_MS}ms)`,
    );
  }
  if (scenario.misreportedStateSamples > 0) {
    failures.push(
      `drag: the transport reported Playing on ${scenario.misreportedStateSamples} ` +
        "samples of a drag that started paused",
    );
  }
  if (
    scenario.resumeAfterRelease.advancedSeconds < RESUME_MIN_ADVANCE_SECONDS
  ) {
    failures.push(
      `drag: play after the release advanced the clock ` +
        `${scenario.resumeAfterRelease.advancedSeconds}s in ${RESUME_PROBE_MS}ms; ` +
        "the producer is still holding the drag's pause",
    );
  }
  return failures;
}

/* ---------------------------------------------------------------- playhead */

const PLAYHEAD_SAMPLER = `(async (holdMs, intervalMs) => {
  const renderer = window.__demoRenderer;
  const samples = [];
  const read = () => {
    const node = document.querySelector(".timeline-view__playhead");
    const state = renderer.getState();
    samples.push({
      at: performance.now(),
      transform: node ? node.style.transform : null,
      currentTime: state.currentTime,
      playbackState: state.playbackState,
      renderCount: renderer.getRenderCount(),
    });
  };
  read();
  const timer = setInterval(read, intervalMs);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  clearInterval(timer);
  read();
  return { samples, visibility: document.visibilityState };
})`;

const READ_PLAYHEAD_PERCENT = `(() => {
  const node = document.querySelector(".timeline-view__playhead");
  const state = window.__demoRenderer.getState();
  return {
    transform: node ? node.style.transform : null,
    currentTime: state.currentTime,
  };
})()`;

function percentFromTransform(transform) {
  const match = /translateX\(([-0-9.]+)%\)/.exec(transform ?? "");
  return match === null ? null : Number(match[1]);
}

/**
 * Where the timeline says the picture is, against where the picture is.
 *
 * Two defects: the playhead kept sliding while the picture stood still, so a
 * paused player looked like it was playing; and the position it drew did not
 * track the time it was drawing.
 */
export async function runPlayhead(session, info, attempts = 1) {
  return stable(session, attempts, () => measurePlayhead(session, info));
}

async function measurePlayhead(session, info) {
  await focusPage(session);
  await session.evaluate(
    `(async () => {
      const renderer = window.__demoRenderer;
      renderer.pause();
      await renderer.seek(${PLAYHEAD_SEEK_SECONDS});
    })()`,
  );
  await delay(800);
  const raw = await session.readJson(
    `(${PLAYHEAD_SAMPLER})(${PLAYHEAD_HOLD_MS}, ${PLAYHEAD_INTERVAL_MS})`,
  );
  if (raw.visibility !== "visible") {
    throw new Invalid(`the demo tab was ${raw.visibility} during the hold`);
  }
  const percents = raw.samples.map((sample) =>
    percentFromTransform(sample.transform),
  );
  if (percents.some((value) => value === null)) {
    throw new Invalid(
      "the timeline playhead is not carrying a translateX transform; the " +
        "control bar changed and this scenario is measuring the wrong node",
    );
  }
  const stoppedDriftPercent = round(
    Math.max(...percents) - Math.min(...percents),
    4,
  );
  const stoppedDriftSeconds = round(
    Math.max(...raw.samples.map((sample) => sample.currentTime)) -
      Math.min(...raw.samples.map((sample) => sample.currentTime)),
    4,
  );
  const playingDuringHold = raw.samples.filter(
    (sample) => sample.playbackState === "playing",
  ).length;

  const points = [];
  for (const fraction of PLAYHEAD_FIT_FRACTIONS) {
    await session.evaluate(
      `window.__demoRenderer.seek(${info.duration * fraction}).then(() => 1)`,
    );
    await delay(350);
    const read = await session.readJson(READ_PLAYHEAD_PERCENT);
    points.push({
      currentTime: read.currentTime,
      percent: percentFromTransform(read.transform),
    });
  }
  const fit = leastSquares(
    points.map((point) => point.currentTime),
    points.map((point) => point.percent),
  );
  const residuals = points.map((point) =>
    Math.abs(point.percent - (fit.slope * point.currentTime + fit.intercept)),
  );
  const impliedDuration = fit.slope === 0 ? null : round(100 / fit.slope, 2);

  const scenario = {
    holdSeconds: PLAYHEAD_HOLD_MS / 1000,
    holdSamples: raw.samples.length,
    stoppedDriftPercent,
    stoppedDriftSeconds,
    playingDuringHold,
    fitPoints: points.map((point) => ({
      currentTime: round(point.currentTime, 3),
      percent: point.percent,
    })),
    worstDisagreementPercent: round(Math.max(...residuals), 4),
    impliedDurationSeconds: impliedDuration,
    mediaDurationSeconds: round(info.duration, 3),
    limits: {
      stoppedDriftPercent: PLAYHEAD_DRIFT_LIMIT_PERCENT,
      disagreementPercent: PLAYHEAD_DISAGREEMENT_LIMIT_PERCENT,
    },
  };

  return { scenario, failures: judgePlayhead(scenario) };
}

export function judgePlayhead(scenario) {
  const failures = [];
  if (scenario.stoppedDriftPercent > PLAYHEAD_DRIFT_LIMIT_PERCENT) {
    failures.push(
      `playhead: it moved ${scenario.stoppedDriftPercent}% of the track across ` +
        `${scenario.holdSeconds}s in which the picture never moved ` +
        `(limit ${PLAYHEAD_DRIFT_LIMIT_PERCENT}%)`,
    );
  }
  if (scenario.playingDuringHold > 0) {
    failures.push(
      `playhead: the transport reported Playing on ${scenario.playingDuringHold} ` +
        "samples of a hold it spent paused",
    );
  }
  if (scenario.worstDisagreementPercent > PLAYHEAD_DISAGREEMENT_LIMIT_PERCENT) {
    failures.push(
      `playhead: it drew ${scenario.worstDisagreementPercent}% away from where the ` +
        `media time puts it (limit ${PLAYHEAD_DISAGREEMENT_LIMIT_PERCENT}%)`,
    );
  }
  return failures;
}

/* --------------------------------------------------------------- backscrub */

/**
 * The same five frames reached walking forwards, then reached again walking
 * backwards. Masks arrived on the forward pass and not on the backward one,
 * The two passes are compared against each other, so no number has to be
 * decided in advance for how much ink a frame owes.
 */
export async function runBackscrub(session, info, attempts = 1) {
  return stable(session, attempts, () => measureBackscrub(session, info));
}

async function measureBackscrub(session, info) {
  await focusPage(session);
  const geometry = await session.readJson(CANVAS_BOX);
  await session.evaluate("window.__demoRenderer.pause(); 1");

  const stops = SCRUB_STOP_FRACTIONS.map((fraction) =>
    round(info.duration * fraction, 3),
  );
  /* Both passes have to arrive from the same side of the first stop, or the
   * forward pass opens with a backward jump and the two are not the same
   * walk. */
  await session.readJson(`(${SETTLE_AT})(0, ${SCRUB_SETTLE_DEADLINE_MS})`);
  const forward = await walk(session, geometry, stops);
  await session.readJson(
    `(${SETTLE_AT})(${round(info.duration, 3)}, ${SCRUB_SETTLE_DEADLINE_MS})`,
  );
  const backward = await walk(session, geometry, [...stops].reverse());
  const backwardByTime = new Map(
    backward.stops.map((stop) => [stop.requested, stop]),
  );

  /* Comparing two photographs is only meaningful if they are photographs of
   * the same frame. */
  const framePeriod = 1 / (info.frameRate || 30);
  for (const stop of forward.stops) {
    const twin = backwardByTime.get(stop.requested);
    if (
      twin === undefined ||
      Math.abs(twin.currentTime - stop.currentTime) > framePeriod / 2
    ) {
      throw new Invalid(
        `asked for ${stop.requested}s twice and landed on ${stop.currentTime}s ` +
          `going forwards and ${twin?.currentTime ?? "nothing"} coming back; ` +
          "there is no pair of frames here to compare",
      );
    }
  }

  const ratios = forward.stops.map((stop) => {
    const twin = backwardByTime.get(stop.requested);
    const forwardInk = stop.colouredFraction;
    const backwardInk = twin?.colouredFraction ?? 0;
    return {
      requested: stop.requested,
      forwardInk,
      backwardInk,
      ratio: forwardInk === 0 ? null : round(backwardInk / forwardInk, 3),
    };
  });
  const usable = ratios
    .map((row) => row.ratio)
    .filter((value) => value !== null);

  const scenario = {
    stops,
    forward: summariseWalk(forward),
    backward: summariseWalk(backward),
    inkByStop: ratios,
    maskInkRatio: usable.length === 0 ? null : Math.min(...usable),
    limits: { maskInkRatio: MASK_INK_RATIO_FLOOR },
  };

  return { scenario, failures: judgeBackscrub(scenario) };
}

export function judgeBackscrub(scenario) {
  const failures = [];
  const unprepared = (pass, stops) =>
    stops
      .filter((stop) => !stop.prepared)
      .map((stop) => `${pass} ${stop.requested}s`);
  const rated = scenario.inkByStop.filter((row) => row.ratio !== null);
  if (rated.length === 0) {
    failures.push(
      "backscrub: the forward pass drew no coloured ink at any stop, so there is " +
        "nothing for the backward pass to be compared against",
    );
  } else if (scenario.maskInkRatio < MASK_INK_RATIO_FLOOR) {
    const worst = rated.reduce((low, row) =>
      row.ratio < low.ratio ? row : low,
    );
    failures.push(
      `backscrub: at ${worst.requested}s the backward pass drew ${worst.ratio} of the ` +
        `ink the forward pass drew (floor ${MASK_INK_RATIO_FLOOR})`,
    );
  }
  const missed = [
    ...unprepared("forwards at", scenario.forward.stops),
    ...unprepared("backwards at", scenario.backward.stops),
  ];
  if (missed.length > 0) {
    failures.push(
      `backscrub: ${missed.join(", ")} never finished preparing within ` +
        `${SCRUB_SETTLE_DEADLINE_MS}ms of landing`,
    );
  }
  return failures;
}

const CANVAS_BOX = `(() => {
  const canvas = document.querySelector("canvas");
  const box = canvas ? canvas.getBoundingClientRect() : null;
  return {
    canvasBox: box
      ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      : null,
  };
})()`;

async function walk(session, geometry, stops) {
  const results = [];
  for (const requested of stops) {
    const settled = await session.readJson(
      `(${SETTLE_AT})(${requested}, ${SCRUB_SETTLE_DEADLINE_MS})`,
    );
    await session.readJson(`(async () => {
      window.__demoRenderer.refresh();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return 1;
    })()`);
    const ink = await readInk(session, geometry);
    results.push({
      requested,
      currentTime: round(settled.currentTime, 4),
      settleMs: settled.settleMs,
      prepared: settled.prepared,
      detectionCount: settled.detectionCount,
      colouredFraction: ink.colouredFraction,
      meanLuminance: ink.meanLuminance,
    });
  }
  return { stops: results };
}

function summariseWalk(walked) {
  const settles = walked.stops.map((stop) => stop.settleMs);
  return {
    settleP95Ms: percentile(settles, 0.95),
    settleMaxMs: Math.max(...settles),
    preparedCount: walked.stops.filter((stop) => stop.prepared).length,
    stops: walked.stops,
  };
}

/* ------------------------------------------------------------------- focus */

const SET_TOGGLE = (label, checked) => `(() => {
  const el = [...document.querySelectorAll("label.render-control--toggle")]
    .find((node) => node.querySelector("span")?.textContent.trim() === ${JSON.stringify(label)});
  if (!el) return { found: false };
  const input = el.querySelector("input");
  if (input.checked !== ${checked} && !input.disabled) input.click();
  return { found: true, checked: input.checked, disabled: input.disabled };
})()`;

const READ_TOGGLE = (label) => `(() => {
  const el = [...document.querySelectorAll("label.render-control--toggle")]
    .find((node) => node.querySelector("span")?.textContent.trim() === ${JSON.stringify(label)});
  const input = el?.querySelector("input");
  return input ? { found: true, checked: input.checked, disabled: input.disabled } : { found: false };
})()`;

/**
 * The focus overlay as two numbers: how much dark it adds to the scene, and
 * how much of the scene it leaves bright. It once vanished outright, which
 * reads as no dark added; losing its cutout reads as no bright left.
 */
export async function runFocus(session, info, attempts = 1) {
  return stable(session, attempts, () => measureFocus(session));
}

async function measureFocus(session) {
  await focusPage(session);
  const geometry = await session.readJson(CANVAS_BOX);
  const restore = await session.readJson(READ_TOGGLE("Focus"));
  if (!restore.found) {
    throw new Invalid("the demo is not showing the Focus toggle");
  }

  try {
    await session.evaluate("window.__demoRenderer.pause(); 1");
    await session.readJson(
      `(${SETTLE_AT})(${FOCUS_SEEK_SECONDS}, ${SCRUB_SETTLE_DEADLINE_MS})`,
    );
    await session.evaluate(SET_TOGGLE("Focus", false));
    await delay(500);
    const off = await readInk(session, geometry, { withLuminance: true });
    await session.evaluate(SET_TOGGLE("Focus", true));
    await delay(700);
    const on = await readInk(session, geometry, { withLuminance: true });

    const comparison = compareLuminance(off, on);
    const scenario = {
      seekSeconds: FOCUS_SEEK_SECONDS,
      sampleSize: `${off.width}x${off.height}`,
      focusOff: {
        darkFraction: off.darkFraction,
        meanLuminance: off.meanLuminance,
      },
      focusOn: {
        darkFraction: on.darkFraction,
        meanLuminance: on.meanLuminance,
      },
      dimmedFractionDelta: round(on.darkFraction - off.darkFraction, 4),
      cutoutFraction: comparison.unchangedBrightFraction,
      dimmedByOverlayFraction: comparison.dimmedFraction,
      floors: {
        dimmedFractionDelta: FOCUS_DIM_DELTA_FLOOR,
        cutoutFraction: FOCUS_CUTOUT_FLOOR,
      },
    };

    return { scenario, failures: judgeFocus(scenario) };
  } finally {
    await session
      .evaluate(SET_TOGGLE("Focus", restore.checked))
      .catch(() => {});
  }
}

export function judgeFocus(scenario) {
  const failures = [];
  if (scenario.dimmedFractionDelta < FOCUS_DIM_DELTA_FLOOR) {
    failures.push(
      `focus: turning it on darkened ${scenario.dimmedFractionDelta} more of the ` +
        `picture (floor ${FOCUS_DIM_DELTA_FLOOR}); the overlay did not draw`,
    );
  }
  if (scenario.cutoutFraction < FOCUS_CUTOUT_FLOOR) {
    failures.push(
      `focus: only ${scenario.cutoutFraction} of the picture stayed bright under the ` +
        `overlay (floor ${FOCUS_CUTOUT_FLOOR}); it dimmed its own subject`,
    );
  }
  return failures;
}

function compareLuminance(off, on) {
  if (off.width !== on.width || off.height !== on.height) {
    throw new Invalid(
      "the canvas changed size between the two shots; there is nothing to compare",
    );
  }
  let bright = 0;
  let unchangedBright = 0;
  let dimmed = 0;
  for (let pixel = 0; pixel < off.luminance.length; pixel += 1) {
    const before = off.luminance[pixel];
    const after = on.luminance[pixel];
    if (before <= 60) continue;
    bright += 1;
    if (Math.abs(after - before) <= 12) unchangedBright += 1;
    else if (after < before - 12) dimmed += 1;
  }
  const total = off.luminance.length;
  return {
    brightFraction: round(bright / total, 4),
    unchangedBrightFraction: round(unchangedBright / total, 4),
    dimmedFraction: round(dimmed / total, 4),
  };
}

/* ----------------------------------------------------------------- hotkeys */

const KEYS = {
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  period: { key: ".", code: "Period", windowsVirtualKeyCode: 190 },
  arrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
};

async function pressKey(session, name) {
  const key = KEYS[name];
  await session.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    autoRepeat: false,
    ...key,
  });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

const FIND_TOGGLE_BOX = (label) => `(() => {
  const el = [...document.querySelectorAll("label.render-control--toggle")]
    .find((node) => node.querySelector("span")?.textContent.trim() === ${JSON.stringify(label)});
  const input = el?.querySelector("input");
  if (!input) return null;
  const box = input.getBoundingClientRect();
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    checked: input.checked,
  };
})()`;

/* A transport that has just been asked to pause is still finishing the frame
 * it was on. Measuring a one-frame step against a clock still settling reads
 * as two frames. */
const AWAIT_STILL = `(async (deadlineMs, quietPolls) => {
  const renderer = window.__demoRenderer;
  const started = performance.now();
  let last = null;
  let quiet = 0;
  while (performance.now() - started < deadlineMs) {
    const state = renderer.getState();
    const now = state.currentTime + ":" + renderer.getRenderCount();
    quiet = now === last ? quiet + 1 : 0;
    if (quiet >= quietPolls) {
      return {
        currentTime: state.currentTime,
        stillMs: Math.round(performance.now() - started),
      };
    }
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return { currentTime: renderer.getState().currentTime, stillMs: deadlineMs };
})`;
const STILL_DEADLINE_MS = 3000;
/* A pause still delivers the frame it was mid-way through, so one quiet
 * reading is not a stopped player. Three at sixty milliseconds is. */
const STILL_QUIET_POLLS = 3;

const READ_TRANSPORT = `(() => {
  const state = window.__demoRenderer.getState();
  return {
    currentTime: state.currentTime,
    playbackState: state.playbackState,
    activeElement: document.activeElement
      ? document.activeElement.tagName + (document.activeElement.type ? ":" + document.activeElement.type : "")
      : null,
  };
})()`;

/**
 * The shortcuts, pressed after a layer checkbox has taken focus.
 *
 * That click is what killed them: a checkbox is an `input`, the key handler
 * treated every focused input as somewhere the user was typing, and every
 * shortcut the hint bar still advertised stopped answering until the page was
 * clicked somewhere else.
 */
export async function runHotkeys(session, info, attempts = 1) {
  return stable(session, attempts, () => measureHotkeys(session, info));
}

async function measureHotkeys(session, info) {
  await focusPage(session);
  const toggle = await session.readJson(FIND_TOGGLE_BOX("Masks"));
  if (toggle === null) {
    throw new Invalid("the demo is not showing the Masks toggle to click");
  }

  await session.evaluate("window.__demoRenderer.pause(); 1");
  await session.readJson(
    `(${SETTLE_AT})(${PLAYHEAD_SEEK_SECONDS}, ${SCRUB_SETTLE_DEADLINE_MS})`,
  );

  await dispatchMouse(session, "mousePressed", toggle.x, toggle.y);
  await dispatchMouse(session, "mouseReleased", toggle.x, toggle.y);
  await delay(HOTKEY_SETTLE_MS);
  const focused = await session.readJson(READ_TRANSPORT);
  /* The checkbox holding focus is the whole premise. A click that missed
   * leaves focus on the body, where every shortcut answers anyway, and the
   * scenario would pass without having tested anything. */
  if (focused.activeElement !== "INPUT:checkbox") {
    throw new Invalid(
      `clicking the Masks toggle left focus on ${focused.activeElement ?? "nothing"}; ` +
        "the click missed and the defect this measures cannot occur",
    );
  }

  const framePeriod = 1 / (info.frameRate || 30);
  const checks = [];

  await session.readJson(
    `(${AWAIT_STILL})(${STILL_DEADLINE_MS}, ${STILL_QUIET_POLLS})`,
  );
  const beforeStep = await session.readJson(READ_TRANSPORT);
  await pressKey(session, "period");
  await delay(HOTKEY_SETTLE_MS);
  const afterStep = await session.readJson(READ_TRANSPORT);
  const stepped = afterStep.currentTime - beforeStep.currentTime;
  checks.push({
    key: "Period",
    expected: "one frame forward",
    answered:
      stepped > 0 && stepped <= framePeriod * HOTKEY_STEP_TOLERANCE_FRAMES,
    detail: `${round(stepped, 4)}s against a ${round(framePeriod, 4)}s frame`,
  });

  await pressKey(session, "space");
  await delay(HOTKEY_SETTLE_MS);
  const afterPlay = await session.readJson(READ_TRANSPORT);
  checks.push({
    key: "Space",
    expected: "playback starts",
    answered: afterPlay.playbackState === "playing",
    detail: `${focused.playbackState} -> ${afterPlay.playbackState}`,
  });

  await pressKey(session, "space");
  await delay(HOTKEY_SETTLE_MS);
  const afterPause = await session.readJson(READ_TRANSPORT);
  checks.push({
    key: "Space again",
    expected: "playback stops",
    answered: afterPause.playbackState !== "playing",
    detail: `${afterPlay.playbackState} -> ${afterPause.playbackState}`,
  });

  await session.readJson(
    `(${AWAIT_STILL})(${STILL_DEADLINE_MS}, ${STILL_QUIET_POLLS})`,
  );
  const beforeSkip = await session.readJson(READ_TRANSPORT);
  await pressKey(session, "arrowRight");
  await delay(HOTKEY_SETTLE_MS);
  const afterSkip = await session.readJson(READ_TRANSPORT);
  const skipped = afterSkip.currentTime - beforeSkip.currentTime;
  checks.push({
    key: "ArrowRight",
    expected: `${HOTKEY_SKIP_SECONDS}s forward`,
    answered: Math.abs(skipped - HOTKEY_SKIP_SECONDS) <= framePeriod * 2,
    detail: `${round(skipped, 4)}s`,
  });

  await session.evaluate(SET_TOGGLE("Masks", toggle.checked)).catch(() => {});

  const answered = checks.filter((check) => check.answered).length;
  const scenario = {
    clicked: "Masks toggle",
    focusedAfterClick: focused.activeElement,
    checks,
    answeredFraction: round(answered / checks.length, 3),
  };
  return { scenario, failures: judgeHotkeys(scenario) };
}

export function judgeHotkeys(scenario) {
  return scenario.checks
    .filter((check) => !check.answered)
    .map(
      (check) =>
        `hotkeys: ${check.key} did not ${check.expected} after a layer toggle ` +
        `took focus (${scenario.focusedAfterClick}); measured ${check.detail}`,
    );
}

/* ----------------------------------------------------------------- summary */

export function guardDetail(name, scenario, field) {
  if (name === "blanking") {
    return [
      field(
        "prepared ahead median / min",
        `${scenario.preparedAheadMedian} / ${scenario.preparedAheadMin} frames` +
          `  (floor ${scenario.floors.preparedAhead})`,
      ),
      field(
        "frames with no detection",
        `${scenario.nullDetectionFraction}  (limit ${scenario.floors.nullDetectionFraction})`,
      ),
      field(
        "frames drawn unprepared",
        `${scenario.unpreparedFraction}  (limit ${scenario.floors.unpreparedFraction})`,
      ),
      field(
        "window",
        `${scenario.samples} samples, ${scenario.mediaSeconds}s of media in ${scenario.wallSeconds}s`,
      ),
    ];
  }
  if (name === "drag") {
    return [
      field(
        "lag mean / p95 / max",
        `${scenario.lagMeanSeconds} / ${scenario.lagP95Seconds} / ${scenario.lagMaxSeconds} s` +
          `  (limit ${scenario.limits.lagP95Seconds}s at p95)`,
      ),
      field(
        "stale hold p95 / max",
        `${scenario.holdP95Ms} / ${scenario.holdMaxMs} ms  (limits ` +
          `${scenario.limits.holdP95Ms} / ${scenario.limits.holdMaxMs})`,
      ),
      field(
        "frames reaching screen",
        `${scenario.framesPresented} over ${scenario.dragSeconds}s = ` +
          `${scenario.framesPerSecond}/s  (floor ${scenario.limits.framesPerSecond}/s)`,
      ),
      field(
        "release",
        `${scenario.releaseMs === null ? "never landed" : `${scenario.releaseMs}ms`}` +
          `  (limit ${scenario.limits.releaseMs}ms)`,
      ),
      field("state misreported", `${scenario.misreportedStateSamples} samples`),
      field(
        "play after release",
        `${scenario.resumeAfterRelease.advancedSeconds}s in ${RESUME_PROBE_MS}ms`,
      ),
    ];
  }
  if (name === "playhead") {
    return [
      field(
        "drift while stopped",
        `${scenario.stoppedDriftPercent}% over ${scenario.holdSeconds}s` +
          `  (limit ${scenario.limits.stoppedDriftPercent}%)`,
      ),
      field("media drift while stopped", `${scenario.stoppedDriftSeconds}s`),
      field(
        "worst disagreement",
        `${scenario.worstDisagreementPercent}%  (limit ${scenario.limits.disagreementPercent}%)`,
      ),
      field(
        "implied / real duration",
        `${scenario.impliedDurationSeconds}s / ${scenario.mediaDurationSeconds}s`,
      ),
    ];
  }
  if (name === "backscrub") {
    return [
      field(
        "backward ink vs forward",
        `${scenario.maskInkRatio}  (floor ${scenario.limits.maskInkRatio})`,
      ),
      field(
        "forward settle p95 / max",
        `${scenario.forward.settleP95Ms} / ${scenario.forward.settleMaxMs} ms`,
      ),
      field(
        "backward settle p95 / max",
        `${scenario.backward.settleP95Ms} / ${scenario.backward.settleMaxMs} ms`,
      ),
      ...scenario.inkByStop.map((row) =>
        field(
          `  ${row.requested}s`,
          `forward ${row.forwardInk}, backward ${row.backwardInk}, ratio ${row.ratio}`,
        ),
      ),
    ];
  }
  if (name === "focus") {
    return [
      field(
        "dark added by the overlay",
        `${scenario.dimmedFractionDelta}  (floor ${scenario.floors.dimmedFractionDelta})`,
      ),
      field(
        "left bright (the cutout)",
        `${scenario.cutoutFraction}  (floor ${scenario.floors.cutoutFraction})`,
      ),
      field(
        "dark fraction off / on",
        `${scenario.focusOff.darkFraction} / ${scenario.focusOn.darkFraction}`,
      ),
    ];
  }
  return [
    field("focused by the click", scenario.focusedAfterClick),
    field("answered", `${scenario.answeredFraction} of the keys pressed`),
    ...scenario.checks.map((check) =>
      field(
        `  ${check.key}`,
        `${check.answered ? "answered" : "DEAD"}  ${check.detail}`,
      ),
    ),
  ];
}

/* ------------------------------------------------------------------- maths */

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return round(sorted[index], 3);
}

function leastSquares(xs, ys) {
  const n = xs.length;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let variance = 0;
  for (let at = 0; at < n; at += 1) {
    covariance += (xs[at] - meanX) * (ys[at] - meanY);
    variance += (xs[at] - meanX) ** 2;
  }
  const slope = variance === 0 ? 0 : covariance / variance;
  return { slope, intercept: meanY - slope * meanX };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { Invalid };
