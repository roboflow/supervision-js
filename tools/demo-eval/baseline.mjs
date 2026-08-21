/* Baseline comparison: what today's numbers were, what this run's numbers are,
 * and which of them moved the wrong way.
 *
 * A threshold catches a fall off a cliff. Nothing in the eval catches a metric
 * that walks from 40ms to 190ms one commit at a time while a 250ms limit keeps
 * reporting pass, which is how every number here got slow the first time. The
 * registry below names the numbers worth watching, the direction each one is
 * allowed to move, and how far it may move before the run says so.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";

const DEFAULT_TOLERANCE_PERCENT = 25;

/**
 * `noise` is the absolute change, in the metric's own unit, that this machine
 * produces run to run without anything having changed. A move smaller than it
 * is never a regression however large its percentage, which is what keeps a
 * metric whose baseline is 0 or 0.4 from crying on every run.
 *
 * A metric whose right answer is a fixed value carries `tolerancePercent: 0`,
 * so its noise floor is the only thing standing between it and a regression.
 *
 * A floor is the full spread one unchanged build produced across every pass
 * that was a measurement, taken on an idle M3 Max and rounded up so the widest
 * honest pass sits inside it: only a move strictly larger than the floor
 * counts, and two readings a tenth apart subtract to a hair over a tenth in
 * binary. The tool's default is a single pass, so a single pass is what a
 * floor has to survive. A pass whose extremes land on several unrelated
 * metrics at once is the machine and not the build: four passes behind these
 * numbers were that, and each entry that leaves one out says which other
 * numbers went with it.
 *
 * A floor of 0 means every pass returned the same number, and where that number
 * is also the only right answer the entry says so.
 */
export const METRICS = [
  {
    key: "paints.paused.paintCount",
    label: "paused paints",
    unit: "",
    better: "lower",
    /* Zero on all thirty-six passes, which is also the only answer the scenario
     * accepts: a paused page that paints is doing per-frame work with no frame
     * to show for it. */
    noise: 0,
    read: (report) => report.paints?.paused?.paintCount,
  },
  {
    key: "paints.playing.paintRate",
    label: "playing paints",
    unit: "/s",
    better: "lower",
    /* Thirty-six passes ran 46.33/s to 53.17/s, thirty-four of them from 50.33
     * up. The two low ones came from passes that were ordinary in every other
     * number, so the spread belongs to the instrument. */
    noise: 7,
    read: (report) => report.paints?.playing?.paintRate,
  },
  {
    key: "paints.playing.styleRecalcRate",
    label: "playing style recalcs",
    unit: "/s",
    better: "lower",
    /* Fifty-eight recalcs over the six second window on thirty-three of
     * thirty-six passes and fifty-seven on the other three, which is 9.7/s
     * against 9.5/s. One event is the whole spread. */
    noise: 0.3,
    read: (report) => report.paints?.playing?.styleRecalcRate,
  },
  {
    key: "paints.playing.layoutRate",
    label: "playing layouts",
    unit: "/s",
    better: "lower",
    /* The same six second window and the same one-event spread as the recalcs:
     * 9.7/s on thirty-three of thirty-six passes, 9.5/s on three. */
    noise: 0.3,
    read: (report) =>
      report.paints?.playing?.layoutRate ??
      rate(report.paints?.playing, "layoutCount"),
  },
  {
    key: "paints.playing.domPaintRate",
    label: "playing DOM paints",
    unit: "/s",
    better: "lower",
    /* Every paint the window traced minus the canvas's own, and this build
     * attributes none to the canvas, so the two read the same number and share
     * a spread: 46.33/s to 53.17/s across thirty-six passes. */
    noise: 7,
    read: (report) => report.paints?.playing?.domPaintRate,
  },
  {
    key: "paints.playing.presentRate",
    label: "playing present rate",
    unit: "/s",
    better: "higher",
    /* Presented frames over the wall time the window spanned: thirty-six passes
     * ran 29.88/s to 30.07/s against a 30fps source. */
    noise: 0.2,
    read: (report) => report.paints?.playing?.presentRate,
  },
  {
    key: "sync.worstDetectionOffsetMs",
    label: "worst detection offset",
    unit: "ms",
    better: "lower",
    /* Exactly 0 on all thirty-six passes: the transport and the detection it is
     * drawing report the same media time. Any other number means the boxes came
     * from a neighbouring frame, which is the defect this scenario exists for,
     * and the one frame period the scenario allows is the cliff. */
    noise: 0,
    read: (report) =>
      maximum(
        (report.sync?.seeks ?? []).map((seek) =>
          seek.currentToDetectionMs === null
            ? null
            : Math.abs(seek.currentToDetectionMs),
        ),
      ),
  },
  {
    key: "sync.worstSettleMs",
    label: "worst detection settle",
    unit: "ms",
    better: "lower",
    /* The wait for a detection frame that is genuinely new, polled at 100ms, so
     * it lands on a poll boundary: thirty-five passes read 101 to 107ms, and
     * thirty-two of those read 101 or 102. A thirty-sixth read 131ms in the
     * pass that also put the seek p95 at 53.8ms, which is the machine. */
    noise: 7,
    read: (report) =>
      maximum((report.sync?.seeks ?? []).map((s) => s.settleMs)),
  },
  {
    key: "latency.seek.p95",
    label: "seek p95",
    unit: "ms",
    better: "lower",
    /* Five awaited seeks, so the p95 is the slowest of them. Thirty-five passes
     * ran 1.8ms to 9.6ms: seventeen sat under 3ms in one session and the rest
     * spread to 9.6ms in another, with nothing changed between them. A
     * thirty-sixth read 53.8ms in the pass that also took 131ms to settle a
     * detection, and no floor should try to cover that one. */
    noise: 10,
    read: (report) => report.latency?.seek?.p95,
  },
  {
    key: "latency.step.p95",
    label: "step p95",
    unit: "ms",
    better: "lower",
    /* Six alternating steps, so the p95 is the slowest of them, and it is the
     * loudest number in the eval: thirty-six passes of one build ran 43.5ms to
     * 73.7ms around a median of 47.7ms, and the passes at the top were ordinary
     * everywhere else. Covering that leaves an entry that cannot see a walk
     * smaller than two thirds of its own median, against a threshold 32ms above
     * it. Fed the 80ms the scenario itself fails at, this entry reads steady,
     * so timing more than six steps a pass is what would make it a gate. */
    noise: 31,
    read: (report) => report.latency?.step?.p95,
  },
  {
    key: "layers.floor.p95",
    label: "layers floor frame p95",
    unit: "ms",
    better: "lower",
    /* Thirty-three passes across two sessions: sixteen read 9.8 to 10.1ms and
     * the seventeen after them 9.0 to 9.2ms, with no change to the demo, the
     * engine, the dist it imports or this harness between them. Inside a
     * session the spread is 0.3ms; the floor covers the step from one session
     * to the next and no more. */
    noise: 1.2,
    read: (report) => configP95(report.layers, report.layers?.floor?.config),
  },
  {
    key: "layers.everythingOn.p95",
    label: "everything-on frame p95",
    unit: "ms",
    better: "lower",
    /* The same two sessions, sampled in the same windows: 9.7 to 10.2ms across
     * the first sixteen passes and 9.1 to 9.2ms across the next seventeen. */
    noise: 1.2,
    read: (report) => configP95(report.layers, "everything-on"),
  },
  {
    key: "cadence.worstMediaSecondFps",
    label: "keypoint worst media second",
    unit: "/s",
    better: "higher",
    /* The slowest media second in either window. The clip is nine seconds and
     * the two windows judge thirteen buckets between them, because the
     * late-start pass re-judges the seconds it shares with the whole-clip pass.
     * Forty passes of one unchanged build: thirty-one landed between 29.91/s
     * and 29.99/s, six between 29.73 and 29.75, one at 29.63 and two at 29.53
     * to 29.54, a full spread of 0.46/s. A floor cut to the thirty-one
     * calls the other nine a regression, so it is the full spread rounded up.
     * The metric carries no tolerance, so anything past half a frame a second
     * off the recorded median is one. The scenario's own gate sits 2.5/s lower
     * and is the cliff; this is the walk. */
    noise: 0.5,
    tolerancePercent: 0,
    read: (report) => worstBucketFps(report.cadence),
  },
  {
    key: "cadence.lateStartFps",
    label: "keypoint late-start present rate",
    unit: "/s",
    better: "higher",
    /* The consumer clock over the window that starts past the stall: presented
     * frames over wall time, and 3.5s of window lands on a whole number of
     * them. The same forty passes returned 104 frames seventeen times, reading
     * 29.65 to 29.70/s, 105 sixteen times, reading 29.92 to 29.97, and 106
     * seven times, reading 30.19 to 30.24. One frame either way is 0.29/s, so
     * the floor clears two of them. */
    noise: 0.65,
    tolerancePercent: 0,
    read: (report) => cadenceWindow(report.cadence, "late-start")?.consumer.fps,
  },
  {
    key: "cadence.longestHoldMs",
    label: "keypoint longest frame hold",
    unit: "ms",
    better: "lower",
    /* Across those forty passes: nineteen sat at 35.1 to 35.5ms, seventeen at
     * 40.5 to 43.5ms and four between at 37.4 to 38.9ms, a full spread of
     * 8.4ms. Taking the full spread leaves the walk past both clusters towards
     * the 66.7ms hold budget; the budget itself is the scenario's gate. */
    noise: 8.5,
    read: (report) =>
      maximum(
        (report.cadence?.windows ?? []).map((w) => w.engine.longestHoldMs),
      ),
  },
  {
    key: "cadence.skippedIntervals",
    label: "keypoint frames held past budget",
    unit: "",
    better: "lower",
    /* Zero on all forty passes, and the longest hold measured 23ms under the
     * budget, so the first one that appears is worth a run failing over. */
    noise: 0,
    tolerancePercent: 0,
    read: (report) =>
      sum((report.cadence?.windows ?? []).map((w) => w.engine.skips)),
  },
  {
    key: "cadence.engineLateFrames",
    label: "keypoint late frames by the engine",
    unit: "",
    better: "lower",
    /* Thirty-eight of forty passes booked none and two booked a single frame
     * over the late-start window, so one is inside the floor and two is not. */
    noise: 1,
    read: (report) =>
      maximum((report.cadence?.windows ?? []).map((w) => w.engine.lateFrames)),
  },
  {
    key: "cadence.engineStalls",
    label: "keypoint stalls by the engine",
    unit: "",
    better: "lower",
    /* Zero on all forty passes. A stall is the engine saying it ran out of
     * frames to paint, so there is no amount of it that is noise. */
    noise: 0,
    tolerancePercent: 0,
    read: (report) =>
      maximum((report.cadence?.windows ?? []).map((w) => w.engine.stalls)),
  },
  {
    key: "cadence.clockDisagreementFps",
    label: "keypoint clocks apart",
    unit: "/s",
    better: "lower",
    /* How far the engine's ledger and the page's presented-frame counter landed
     * from each other across the forty passes: fourteen at 0.10/s or under,
     * twenty-five between 0.19 and 0.37, and one at 0.58, a spread of 0.55/s.
     * Drifting apart is the tell that one of them stopped watching the same
     * thing. */
    noise: 0.6,
    read: (report) =>
      maximum((report.cadence?.windows ?? []).map((w) => w.disagreementFps)),
  },
  {
    key: "throttle.presentedRateFraction",
    label: "throttled present fraction",
    unit: "",
    better: "higher",
    /* Thirty passes at the 2x throttle held 0.988 to 0.999 of the source rate.
     * A thirty-first read 0.901 in the pass that also booked the window's
     * longest task and the slowest backward settle. Thirty-four passes of a
     * full run held 0.984 to 1.002, and inside each of the two largest groups
     * that shared one build the spread was 0.009 and 0.012; a thirty-fifth read
     * 0.575 beside a test suite and failed the scenario outright, which is the
     * only pass any of this moved on. The floor is the width of that band and
     * has to be the whole gate: a quarter off 0.989 is 0.742, under the 0.9 the
     * scenario fails at, so a tolerance beside the floor speaks only about
     * pictures the run has already failed on. */
    noise: 0.012,
    tolerancePercent: 0,
    read: (report) => report.throttle?.presentedRateFraction,
  },
  {
    key: "throttle.coverage",
    label: "throttled detection coverage",
    unit: "",
    better: "higher",
    /* Exactly 1.000 on all thirty-one passes: every frame the sampler read
     * under the throttle carried a detection. The first one that does not is
     * the blanking defect arriving under load, and the scenario's own 0.97
     * floor is the cliff. */
    noise: 0,
    tolerancePercent: 0,
    read: (report) => report.throttle?.coverage,
  },
  {
    key: "throttle.longTaskMaxMs",
    label: "throttled longest task",
    unit: "ms",
    better: "lower",
    /* The longest main-thread task the window saw, and the browser reports no
     * task under 50ms, so this is 0 or it is 50 and up with nothing in between.
     * Which end it lands on depends on what ran ahead of it: thirty-two of
     * thirty-five passes of a full run, where cadence plays the clip through
     * first, read 51 to 58ms, while the same window with only layers ahead of
     * it read 0. Two of the thirty-five read 0 in passes a rebuild hot-patched,
     * and one read 80ms in the pass whose throttled picture fell to 0.575. The
     * floor is the width of the 51-to-58 band, so a longest task that has grown
     * reports far under the scenario's 200ms ceiling, and a window that finds
     * none reads 0 and counts as the improvement it is. */
    noise: 7,
    read: (report) => report.throttle?.longTaskMaxMs,
  },
  {
    key: "battery.failures",
    label: "battery failures",
    unit: "",
    better: "lower",
    /* A failing battery scenario is a wedged frame pump, so no amount of it is
     * noise. Unmeasured this session: the harness serving the battery was not
     * running, and the scenario skipped. */
    noise: 0,
    read: (report) => report.battery?.failures,
  },
  {
    key: "blanking.preparedAheadMedian",
    label: "prepared ahead of playhead",
    unit: " frames",
    better: "higher",
    /* Exactly 208 frames on forty-two passes, and the throttle scenario read
     * the same window at the same depth on every one of its own. The only other
     * reading, 197, came from the pass that put every metric in this file at
     * its extreme. */
    noise: 0,
    read: (report) => report.blanking?.preparedAheadMedian,
  },
  {
    key: "blanking.nullDetectionFraction",
    label: "frames drawing no detection",
    unit: "",
    better: "lower",
    /* Zero on all thirty passes. A sampled frame drawing no detection at all is
     * the blanking defect itself, so the first one is worth a run failing
     * over. */
    noise: 0,
    read: (report) => report.blanking?.nullDetectionFraction,
  },
  {
    key: "blanking.unpreparedFraction",
    label: "frames drawn unprepared",
    unit: "",
    better: "lower",
    /* Zero on all thirty passes: nothing reached the screen ahead of its own
     * masks. */
    noise: 0,
    read: (report) => report.blanking?.unpreparedFraction,
  },
  {
    key: "drag.staleMeanMs",
    label: "drag picture out of date",
    unit: "ms",
    better: "lower",
    /* Twenty-nine cold drags on one unchanged build ran 22.4ms to 34.9ms.
     * Resampling three of those twenty-nine puts the recorded median between
     * 23.1ms and 33.1ms, so two recordings of one build can sit 10ms apart with
     * nothing having changed between them. */
    noise: 10,
    read: (report) => report.drag?.staleMeanMs,
  },
  {
    key: "drag.holdP95Ms",
    label: "drag stale hold p95",
    unit: "ms",
    better: "lower",
    /* Twenty-seven passes with the drag as the only scenario held 47.8ms to
     * 74.1ms. The same gesture at the end of a full run inherits whatever the
     * ten scenarios before it left in the page, and nineteen of those spread
     * 50.3ms to 234.7ms on this build inside the same hour. The floor is the
     * measured gesture, so a full run reports this entry moving until the
     * scenario is given a starting state of its own. */
    noise: 27,
    read: (report) => report.drag?.holdP95Ms,
  },
  {
    key: "drag.holdMaxMs",
    label: "drag longest stale hold",
    unit: "ms",
    better: "lower",
    /* The longest single hold in the same gesture: twenty-seven passes with the
     * drag alone ran 49.4ms to 111.6ms, and nineteen at the end of a full run
     * spread 60.6ms to 333.4ms. */
    noise: 63,
    read: (report) => report.drag?.holdMaxMs,
  },
  {
    key: "drag.framesPerSecond",
    label: "drag frames reaching screen",
    unit: "/s",
    better: "higher",
    /* Twenty-seven passes with the drag alone put 47.17 to 66.47 frames a
     * second on the screen; nineteen at the end of a full run managed 18.46 to
     * 52.68 of them. */
    noise: 20,
    read: (report) => report.drag?.framesPerSecond,
  },
  {
    key: "drag.releaseMs",
    label: "drag release",
    unit: "ms",
    better: "lower",
    /* How long the transport took to report the released position, read off a
     * requestAnimationFrame sampler, so it counts frames: nineteen of
     * twenty-six passes landed inside 7ms, seven took 40 to 93ms and one more
     * never landed at all. Nothing in the pass separates the two modes, so a
     * floor quiet enough to clear the slow one cannot report anything until a
     * release is a fifth of the way to the scenario's 500ms limit. */
    noise: 93,
    read: (report) => report.drag?.releaseMs,
  },
  {
    key: "playhead.stoppedDriftPercent",
    label: "playhead drift while stopped",
    unit: "%",
    better: "lower",
    /* Zero on all twenty-nine passes. A playhead sliding while the picture is
     * stopped is the defect, and there is no small honest amount of it. */
    noise: 0,
    read: (report) => report.playhead?.stoppedDriftPercent,
  },
  {
    key: "playhead.worstDisagreementPercent",
    label: "playhead vs picture disagreement",
    unit: "%",
    better: "lower",
    /* 0.031% on all twenty-nine passes: five seeks to fixed fractions and a
     * line fitted through them return the same worst residual every time, so a
     * different number means the playhead is drawn somewhere else. */
    noise: 0,
    read: (report) => report.playhead?.worstDisagreementPercent,
  },
  {
    key: "backscrub.maskInkRatio",
    label: "backward-scrub mask ink",
    unit: "x forward",
    better: "higher",
    /* Exactly 1.000 on all twenty-eight passes, and on thirty-six more of a
     * full run across sixteen build states: every backward stop carried the ink
     * its forward stop had. Each stop's ratio is rounded to three decimals, so
     * a thousandth of the forward ink is the smallest move there is to report,
     * and the floor has to be the whole gate: a quarter off 1.000 is 0.75,
     * under the 0.9 the scenario itself fails at. */
    noise: 0,
    tolerancePercent: 0,
    read: (report) => report.backscrub?.maskInkRatio,
  },
  {
    key: "backscrub.settleP95Ms",
    label: "backward-scrub settle p95",
    unit: "ms",
    better: "lower",
    /* Twenty-seven passes through a six-scenario run spread 144ms to 165ms, the
     * first ten of them between 144 and 153 and the rest from 152 up, one
     * session apart. A twenty-eighth read 235ms in the pass that also dropped
     * the throttled picture to 0.901. The same five stops at the end of a full
     * run meet a busier page: seventeen of those spread 155ms to 459ms. */
    noise: 22,
    read: (report) => report.backscrub?.backward?.settleP95Ms,
  },
  {
    key: "focus.dimmedFractionDelta",
    label: "focus dim added",
    unit: "",
    better: "higher",
    /* One paused frame photographed with the overlay off and on, which returns
     * the same fraction on every pass of a session and stepped once between
     * two: 0.1628 across thirty passes and 0.1621 across the fourteen after
     * them, with nothing changed in between. */
    noise: 0.0008,
    read: (report) => report.focus?.dimmedFractionDelta,
  },
  {
    key: "focus.cutoutFraction",
    label: "focus cutout left bright",
    unit: "",
    better: "higher",
    /* The same pair of photographs and the same step between the same two
     * sessions: 0.1001 across thirty passes and 0.1016 across the fourteen
     * after them. */
    noise: 0.0016,
    read: (report) => report.focus?.cutoutFraction,
  },
  {
    key: "hotkeys.answeredFraction",
    label: "hotkeys answering after a click",
    unit: "",
    better: "higher",
    /* All four shortcuts answered on all twenty-eight passes. */
    noise: 0,
    tolerancePercent: 0,
    read: (report) => report.hotkeys?.answeredFraction,
  },
];

const METRICS_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));

function rate(phase, countKey) {
  if (!phase || !(phase.elapsedSeconds > 0)) return undefined;
  return round(phase[countKey] / phase.elapsedSeconds, 2);
}

function cadenceWindow(cadence, name) {
  return cadence?.windows?.find((window) => window.name === name);
}

/** The slowest media second any window judged: the reading a run average hides. */
function worstBucketFps(cadence) {
  const judged = (cadence?.windows ?? []).flatMap((window) =>
    window.buckets
      .filter((bucket) => bucket.judged)
      .map((bucket) => bucket.fps),
  );
  return judged.length === 0 ? undefined : Math.min(...judged);
}

function sum(values) {
  const usable = values.filter((value) => typeof value === "number");
  return usable.length === 0
    ? undefined
    : usable.reduce((total, value) => total + value, 0);
}

function configP95(layers, name) {
  return layers?.configs?.find((config) => config.name === name)?.p95;
}

function maximum(values) {
  const usable = values.filter((value) => typeof value === "number");
  return usable.length === 0 ? undefined : Math.max(...usable);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Every registry metric this report carries, as a flat key/value map. */
export function readMetrics(scenarios) {
  const values = {};
  for (const metric of METRICS) {
    const value = metric.read(scenarios);
    if (typeof value === "number" && Number.isFinite(value)) {
      values[metric.key] = value;
    }
  }
  return values;
}

/**
 * The part of the machine that decides what a millisecond means here. A
 * baseline recorded on a different one is not a baseline, it is someone else's
 * numbers, so the comparison flags the mismatch before printing any delta.
 */
export function machineFingerprint() {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()}-${os.arch()}`,
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

export function sameMachine(left, right) {
  if (!left || !right) return false;
  return (
    left.platform === right.platform &&
    left.cpu === right.cpu &&
    left.cores === right.cores
  );
}

/**
 * @returns the recorded baseline, or `{ unreadable }` naming why there is none.
 * A baseline nobody can parse must not take the whole measurement down with it.
 */
export async function loadBaseline(path) {
  let serialized;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { unreadable: error.message };
  }
  try {
    return JSON.parse(serialized);
  } catch (error) {
    return { unreadable: `${path} is not valid JSON: ${error.message}` };
  }
}

export async function saveBaseline(path, baseline) {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/**
 * Which commit of each repository the numbers describe. A baseline recorded
 * from a dirty tree measured somebody's uncommitted work, so the file says so
 * rather than presenting it as the state of a commit.
 */
export function sourceFingerprint(repositories) {
  const entry = ([name, directory]) => {
    try {
      const git = (...args) =>
        execFileSync("git", ["-C", directory, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      return [
        name,
        {
          commit: git("rev-parse", "--short", "HEAD"),
          dirty: git("status", "--porcelain").length > 0,
        },
      ];
    } catch {
      return [name, null];
    }
  };
  return Object.fromEntries(Object.entries(repositories).map(entry));
}

export function buildBaseline({
  runs,
  media,
  viewMode,
  samples,
  source,
  values,
  recordedWithFailures = [],
}) {
  return {
    recordedAt: new Date().toISOString(),
    machine: machineFingerprint(),
    source,
    runs,
    media,
    viewMode,
    recordedWithFailures,
    toleranceDefaultPercent: DEFAULT_TOLERANCE_PERCENT,
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          value,
          unit: METRICS_BY_KEY.get(key)?.unit ?? "",
          better: METRICS_BY_KEY.get(key)?.better ?? "lower",
          samples: samples?.[key] ?? [value],
        },
      ]),
    ),
  };
}

/**
 * @returns rows for every registry metric either side carries, each carrying
 * the percentage it moved and whether that counts as a regression.
 */
export function compareToBaseline(values, baseline, options = {}) {
  const tolerancePercent =
    options.tolerancePercent ??
    baseline?.toleranceDefaultPercent ??
    DEFAULT_TOLERANCE_PERCENT;
  const rows = [];

  for (const metric of METRICS) {
    const current = values[metric.key];
    const recorded = baseline?.metrics?.[metric.key]?.value;
    const hasCurrent = typeof current === "number";
    const hasRecorded = typeof recorded === "number";

    if (!hasCurrent && !hasRecorded) continue;
    if (!hasRecorded) {
      rows.push({
        ...describe(metric),
        current,
        baseline: null,
        verdict: "new",
      });
      continue;
    }
    if (!hasCurrent) {
      rows.push({
        ...describe(metric),
        current: null,
        baseline: recorded,
        verdict: "not-measured",
      });
      continue;
    }

    const change = current - recorded;
    const worse = metric.better === "higher" ? -change : change;
    const percent =
      recorded === 0 ? null : round((change / Math.abs(recorded)) * 100, 1);
    const worsePercent =
      percent === null ? null : metric.better === "higher" ? -percent : percent;
    const beyondNoise = Math.abs(change) > metric.noise;
    const beyondTolerance =
      worsePercent === null
        ? worse > 0
        : worsePercent > (metric.tolerancePercent ?? tolerancePercent);

    rows.push({
      ...describe(metric),
      current,
      baseline: recorded,
      change: round(change, 4),
      percent,
      verdict:
        worse > 0 && beyondNoise && beyondTolerance
          ? "regressed"
          : worse < 0 && beyondNoise
            ? "improved"
            : "steady",
    });
  }

  return {
    tolerancePercent,
    rows,
    regressions: rows.filter((row) => row.verdict === "regressed"),
  };
}

function describe(metric) {
  return {
    key: metric.key,
    tolerancePercent: metric.tolerancePercent ?? null,
    label: metric.label,
    unit: metric.unit,
    better: metric.better,
    noise: metric.noise,
  };
}

/** One line per metric, in the shape the run summary prints. */
export function formatRow(row) {
  if (row.verdict === "new") {
    return `${row.label}: ${format(row.current, row.unit)} (no baseline yet)`;
  }
  if (row.verdict === "not-measured") {
    return `${row.label}: not measured this run (baseline ${format(row.baseline, row.unit)})`;
  }
  const direction =
    row.percent === null
      ? ""
      : `${row.percent > 0 ? "+" : ""}${row.percent}%  `;
  return (
    `${row.label}: ${format(row.current, row.unit)}  ${direction}` +
    `(baseline ${format(row.baseline, row.unit)}, ${row.better} is better)`
  );
}

function format(value, unit) {
  if (value === null || value === undefined) return "none";
  return `${value}${unit}`;
}

/** The median, which is what a repeated measurement on a loaded machine owes. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round((sorted[middle - 1] + sorted[middle]) / 2, 4)
    : sorted[middle];
}

export function spread(values) {
  if (values.length < 2) return 0;
  return round(Math.max(...values) - Math.min(...values), 4);
}

export { DEFAULT_TOLERANCE_PERCENT };
