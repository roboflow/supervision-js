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
// The prepared window honestly reports itself filling for a few seconds
// after a pause; steady state is what the zero-paint law governs.
const PAUSED_STEADY_STATE_MS = 6000;
const VIEWPORT = { width: 1500, height: 1150, deviceScaleFactor: 1 };
const SEEK_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const STEP_COUNT = 6;
const RECT_TOLERANCE_PX = 2;
/* A playing window that advances less than this fraction of wall time is not a
 * measurement of playback, whatever the trace says. */
const MIN_ADVANCE_RATIO = 0.25;
const SEEK_P95_LIMIT_MS = 250;
const STEP_P95_LIMIT_MS = 80;
/* A canvas presenting video paints once per presented frame, so the budget has
 * to sit above a readout updating and below a page repainting per frame. Tying
 * it to the present rate instead made a per-frame repaint pass by construction. */
const DOM_PAINT_RATE_LIMIT = 15;
/* Style invalidations per second while playing. A player at steady state should
 * not need one per presented frame, let alone the four measured here; each one
 * pulls layout and paint behind it on the main thread, which is the budget a
 * weaker machine does not have. */
const STYLE_RECALC_RATE_LIMIT = 60;
/* Layouts per second while playing. A layout is a style recalc that had to be
 * paid for, so this sits below the style budget: a player at steady state is
 * drawing into a canvas, and the boxes around it are not supposed to be
 * changing size. Measured at 8.8/s once the playhead moved on a promoted
 * transform, and at 16.8/s before it. */
const LAYOUT_RATE_LIMIT = 30;
const DETECTION_SETTLE_MS = 8000;
/* How long a seek may take to answer with a covered, genuinely new detection.
 * Fifteen seeks across three runs settled in 100ms to 126ms, so a seek spending
 * four times that is waiting on something, and one that never settles rides the
 * DETECTION_SETTLE_MS deadline out and lands far above this. */
const SEEK_SETTLE_LIMIT_MS = 500;
const BATTERY_TIMEOUT_MS = 900_000;
/* The basketball clip, under whichever name the demo is offering it. Its
 * detections thicken from 3.8 a frame at the clip's opening to a plateau of
 * 12.9 to 13.1 from media 4 onwards, which is the half of the clip the stall
 * lived in, and nothing else in this harness selects it. The buttons carry no
 * identifier, so a label is the only handle, and more than one fixture has
 * carried this clip; the first name the demo answers to wins. */
const CADENCE_FIXTURE_LABELS = [
  "Basketball with Keypoints",
  "9s basketball sample",
];
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
    canvasBox: box
      ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
  };
})()`;

class Invalid extends Error {}

function invalid(reason) {
  throw new Invalid(reason);
}

/* The demo remembers which view it was left in, and the Debug view carries
 * fifty-four readouts that rewrite ten times a second. Measured in it, the
 * paused page painted 1440 times in a window that owes zero and the playing
 * DOM paint rate read 277/s against 46/s in the Demo view. Every number here
 * therefore states the view it was taken in, and the run picks one rather than
 * inheriting whatever the last person clicked. */
const VIEW_MODE_STORAGE_KEY = "supervision-demo:view-mode";
const VIEW_MODES = ["benchmarks", "demo", "debug"];

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
    if (changed) {
      const navMark = session.navigations;
      await session.send("Page.reload");
      const deadline = Date.now() + 15_000;
      while (session.navigations === navMark && Date.now() < deadline) {
        await delay(100);
      }
    }
  }
  const info = await waitForRenderer(session, readyTimeoutMs);
  const settled = await session.evaluate(
    `localStorage.getItem(${JSON.stringify(VIEW_MODE_STORAGE_KEY)}) ?? "demo"`,
  );
  return { session, targetId: target.id, info: { ...info, viewMode: settled } };
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

/**
 * Paint passes over the trace window, bucketed by the clip each one carries.
 *
 * A clip is the cull rect of the paint chunk it belongs to, not the region that
 * was invalidated, so every paint into the root scrolling layer reports the
 * whole viewport however small the damage was. The histogram is therefore a
 * census of paint passes and the layers they went into, and it answers nothing
 * about how far a repaint spread; `measurePaintDamage` is what answers that.
 */
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
 * The rect the canvas presents through, and only when it is provably that: a
 * rect the size of the canvas own box. A viewport-sized rect was once credited
 * to the canvas whenever the canvas covered enough of the page, which spent the
 * whole budget on an assumption and left a page repainting per frame
 * indistinguishable from a video presenting.
 */
function findCanvasRect(rects, geometry) {
  const own = rects.find((rect) => matchesBox(rect, geometry.canvas));
  return own ? { ...own, source: "canvas-box" } : null;
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

const DAMAGE_SHOT_COUNT = 3;
const DAMAGE_SHOT_INTERVAL_MS = 900;
/* The widest damage the transport legitimately produces is one timeline lane
 * fill; the flood this guards against covers a stage. */
const DAMAGE_AREA_LIMIT_FRACTION = 0.01;
/* A flash reaching this far across both axes is the page redrawing behind the
 * picture rather than any one element of it. Measured: the canvas, the widest
 * thing that legitimately flashes, covers 0.43 of the viewport across and 0.74
 * down, and a root-background write flashes it whole at 1.0 by 1.0. */
const VIEWPORT_FLASH_FRACTION = 0.9;

const GREEN_COMPONENTS = `(async (dataUrl) => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const surface = new OffscreenCanvas(image.width, image.height);
  const context = surface.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
  const isFlash = (index) => {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    return g > 90 && g - r > 45 && g - b > 45;
  };
  const seen = new Uint8Array(width * height);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || !isFlash(start * 4)) continue;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop();
      const x = at % width;
      const y = (at / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      pixels += 1;
      for (const next of [at - 1, at + 1, at - width, at + width]) {
        if (next < 0 || next >= width * height) continue;
        if (Math.abs((next % width) - x) > 1) continue;
        if (seen[next] || !isFlash(next * 4)) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (pixels > 40) {
      boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }
  return boxes;
})`;

function coversViewport(box, geometry) {
  return (
    box.width >= geometry.viewport.width * VIEWPORT_FLASH_FRACTION &&
    box.height >= geometry.viewport.height * VIEWPORT_FLASH_FRACTION
  );
}

function overlapsCanvas(box, canvas) {
  if (canvas === null) return false;
  return (
    box.x < canvas.x + canvas.width + RECT_TOLERANCE_PX &&
    box.x + box.width > canvas.x - RECT_TOLERANCE_PX &&
    box.y < canvas.y + canvas.height + RECT_TOLERANCE_PX &&
    box.y + box.height > canvas.y - RECT_TOLERANCE_PX
  );
}

/**
 * How far a repaint spread while playing: the largest region the paint-rect
 * overlay flashed away from the picture, and how many times it flashed the
 * viewport whole.
 *
 * A Paint event's `clip` is the cull rect of the paint chunk it belongs to, not
 * the region that was invalidated, so every paint in the root scrolling layer
 * reports the whole viewport however small the damage was. The overlay's rects
 * are the only reading that answers how far a repaint actually spread.
 *
 * The two readings are taken from different sides of the canvas because a
 * repaint of everything necessarily covers the picture too, so the
 * away-from-the-picture filter that makes the largest region meaningful is the
 * same filter that would hide a page-wide flood completely.
 *
 * Three shots is a sample rather than a census: the overlay holds each rect for
 * about a frame, so a flood that runs for a whole window is caught and a single
 * stray repaint may not be.
 */
async function measurePaintDamage(session, geometry) {
  await session.send("DOM.enable");
  await session.send("Overlay.enable");
  await session.send("Overlay.setShowPaintRects", { result: true });
  const boxes = [];
  try {
    for (let shot = 0; shot < DAMAGE_SHOT_COUNT; shot += 1) {
      await delay(DAMAGE_SHOT_INTERVAL_MS);
      const { data } = await session.send("Page.captureScreenshot", {
        format: "png",
      });
      const found = await session.readJson(
        `${GREEN_COMPONENTS}("data:image/png;base64,${data}")`,
      );
      boxes.push(...found);
    }
  } finally {
    await session.send("Overlay.setShowPaintRects", { result: false });
  }

  const canvas = geometry.canvasBox ?? null;
  const outside = boxes.filter((box) => !overlapsCanvas(box, canvas));
  outside.sort((a, b) => b.width * b.height - a.width * a.height);
  const largest = outside[0] ?? null;
  return {
    shots: DAMAGE_SHOT_COUNT,
    viewportFlashes: boxes.filter((box) => coversViewport(box, geometry))
      .length,
    largestOutsidePicture: largest
      ? {
          size: `${largest.width}x${largest.height}`,
          area: largest.width * largest.height,
        }
      : null,
    outsidePictureBoxes: outside
      .slice(0, 8)
      .map((box) => `${box.width}x${box.height}@${box.x},${box.y}`),
  };
}

export async function runPaints(session, info, attempts) {
  const geometry = await session.readJson(GEOMETRY);
  const windowSeconds = TRACE_WINDOW_MS / 1000;

  const measure = async () => {
    await session.send("Page.bringToFront");
    await session.evaluate("window.__demoRenderer.pause(); 1");
    await delay(PAUSED_STEADY_STATE_MS);
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
    const damage = await measurePaintDamage(session, geometry);
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
        damage,
      },
    };
  };

  const phases = await attemptStable(session, attempts, measure, {
    guardPatches: true,
  });
  const excluded = phases.playing.canvasPaintCount;
  const domPaintCount = phases.playing.paintCount - excluded;
  const domPaintRate = round(domPaintCount / windowSeconds, 2);
  const domPaintRateLimit = DOM_PAINT_RATE_LIMIT;

  const failures = [];
  if (phases.paused.paintCount !== 0) {
    failures.push(
      `paints: paused window painted ${phases.paused.paintCount} times, expected 0`,
    );
  }
  if (domPaintRate >= domPaintRateLimit) {
    failures.push(
      `paints: the main thread ran ${domPaintRate} paint passes a second ` +
        `beside the picture, over the ${domPaintRateLimit}/s budget`,
    );
  }
  const styleRecalcRate = round(
    phases.playing.updateLayoutTreeCount / windowSeconds,
    1,
  );
  if (styleRecalcRate >= STYLE_RECALC_RATE_LIMIT) {
    failures.push(
      `paints: ${styleRecalcRate} style recalcs/s while playing is not under ${STYLE_RECALC_RATE_LIMIT}/s`,
    );
  }
  const layoutRate = round(phases.playing.layoutCount / windowSeconds, 1);
  if (layoutRate >= LAYOUT_RATE_LIMIT) {
    failures.push(
      `paints: ${layoutRate} layouts/s while playing is not under ${LAYOUT_RATE_LIMIT}/s`,
    );
  }
  const viewportPaintCount = phases.playing.damage.viewportFlashes;
  if (viewportPaintCount > 0) {
    failures.push(
      `paints: the paint-rect overlay flashed the whole ` +
        `${geometry.viewport.width}x${geometry.viewport.height} viewport on ` +
        `${viewportPaintCount} of ${phases.playing.damage.shots} shots while playing`,
    );
  }
  const damageAreaLimit = Math.round(
    geometry.viewport.width *
      geometry.viewport.height *
      DAMAGE_AREA_LIMIT_FRACTION,
  );
  const largestDamage = phases.playing.damage.largestOutsidePicture;
  if (largestDamage !== null && largestDamage.area > damageAreaLimit) {
    failures.push(
      `paints: playing repainted ${largestDamage.size} (${largestDamage.area}px²) ` +
        `away from the picture, over the ${damageAreaLimit}px² budget ` +
        `(${phases.playing.damage.outsidePictureBoxes.join(", ")})`,
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
        viewportPaintCount,
        domPaintCount,
        domPaintRate,
        domPaintRateLimit,
        styleRecalcRate,
        styleRecalcRateLimit: STYLE_RECALC_RATE_LIMIT,
        layoutRate,
        layoutRateLimit: LAYOUT_RATE_LIMIT,
        damageAreaLimit,
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

  const label = CADENCE_FIXTURE_LABELS.find((candidate) =>
    opening.some((button) => button.label === candidate),
  );
  if (!label) {
    invalid(
      "the demo is not offering the basketball clip as " +
        `${CADENCE_FIXTURE_LABELS.map((name) => `"${name}"`).join(" or ")}; ` +
        `it has ${opening.map((button) => `"${button.label}"`).join(", ")}`,
    );
  }

  try {
    const fixture = await selectFixture(session, label);
    return await measureCadence(session, fixture, attempts);
  } finally {
    await selectFixture(session, pressed.label).catch(() => {});
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
      { guardPatches: true },
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
        "what it painted cannot be read; no video engine source is open",
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

const FIXTURE_BUTTONS = `[...document.querySelectorAll(".source-controls__mode button")]
  .map((button) => ({
    label: button.textContent.trim(),
    pressed: button.getAttribute("aria-pressed") === "true",
    disabled: button.disabled,
  }))`;

function readFixtureButtons(session) {
  return session.readJson(FIXTURE_BUTTONS);
}

const clickFixture = (label) => `(() => {
  const button = [...document.querySelectorAll(".source-controls__mode button")]
    .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
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
async function selectFixture(session, label, timeoutMs = 90_000) {
  const buttons = await readFixtureButtons(session);
  const wanted = buttons.find((button) => button.label === label);
  if (!wanted) {
    invalid(
      `the demo is not offering a "${label}" source; it has ` +
        `${buttons.map((button) => `"${button.label}"`).join(", ")}`,
    );
  }
  if (wanted.pressed) return waitForRenderer(session, timeoutMs);

  const clicked = await session.readJson(clickFixture(label));
  if (clicked.disabled) {
    invalid(`the "${label}" source button was disabled when the sweep set it`);
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
      return { ...info, label };
    }
    await delay(200);
  }
  invalid(
    `the demo stayed on its previous source after "${label}" was clicked`,
  );
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
