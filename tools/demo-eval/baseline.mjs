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
 * The floors below come from the spread of three passes recorded back to back
 * on an idle M3 Max, halved: the baseline stores a median, which already
 * throws away the one disturbed pass in three that this machine produces.
 */
export const METRICS = [
  {
    key: "paints.paused.paintCount",
    label: "paused paints",
    unit: "",
    better: "lower",
    noise: 1,
    read: (report) => report.paints?.paused?.paintCount,
  },
  {
    key: "paints.playing.paintRate",
    label: "playing paints",
    unit: "/s",
    better: "lower",
    noise: 3,
    read: (report) => report.paints?.playing?.paintRate,
  },
  {
    key: "paints.playing.styleRecalcRate",
    label: "playing style recalcs",
    unit: "/s",
    better: "lower",
    noise: 5,
    read: (report) => report.paints?.playing?.styleRecalcRate,
  },
  {
    key: "paints.playing.layoutRate",
    label: "playing layouts",
    unit: "/s",
    better: "lower",
    noise: 3,
    read: (report) =>
      report.paints?.playing?.layoutRate ??
      rate(report.paints?.playing, "layoutCount"),
  },
  {
    key: "paints.playing.domPaintRate",
    label: "playing DOM paints",
    unit: "/s",
    better: "lower",
    noise: 2,
    read: (report) => report.paints?.playing?.domPaintRate,
  },
  {
    key: "paints.playing.presentRate",
    label: "playing present rate",
    unit: "/s",
    better: "higher",
    noise: 1,
    read: (report) => report.paints?.playing?.presentRate,
  },
  {
    key: "sync.worstDetectionOffsetMs",
    label: "worst detection offset",
    unit: "ms",
    better: "lower",
    noise: 5,
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
    noise: 50,
    read: (report) =>
      maximum((report.sync?.seeks ?? []).map((s) => s.settleMs)),
  },
  {
    key: "latency.seek.p95",
    label: "seek p95",
    unit: "ms",
    better: "lower",
    noise: 10,
    read: (report) => report.latency?.seek?.p95,
  },
  {
    key: "latency.step.p95",
    label: "step p95",
    unit: "ms",
    better: "lower",
    noise: 12,
    read: (report) => report.latency?.step?.p95,
  },
  {
    key: "layers.floor.p95",
    label: "layers floor frame p95",
    unit: "ms",
    better: "lower",
    noise: 2,
    read: (report) => configP95(report.layers, report.layers?.floor?.config),
  },
  {
    key: "layers.everythingOn.p95",
    label: "everything-on frame p95",
    unit: "ms",
    better: "lower",
    noise: 2,
    read: (report) => configP95(report.layers, "everything-on"),
  },
  {
    key: "throttle.presentedRateFraction",
    label: "throttled present fraction",
    unit: "",
    better: "higher",
    noise: 0.05,
    read: (report) => report.throttle?.presentedRateFraction,
  },
  {
    key: "throttle.coverage",
    label: "throttled detection coverage",
    unit: "",
    better: "higher",
    noise: 0.02,
    tolerancePercent: 0,
    read: (report) => report.throttle?.coverage,
  },
  {
    key: "throttle.longTaskMaxMs",
    label: "throttled longest task",
    unit: "ms",
    better: "lower",
    noise: 60,
    read: (report) => report.throttle?.longTaskMaxMs,
  },
  {
    key: "battery.failures",
    label: "battery failures",
    unit: "",
    better: "lower",
    noise: 0,
    read: (report) => report.battery?.failures,
  },
  {
    key: "blanking.preparedAheadMedian",
    label: "prepared ahead of playhead",
    unit: " frames",
    better: "higher",
    noise: 10,
    read: (report) => report.blanking?.preparedAheadMedian,
  },
  {
    key: "blanking.nullDetectionFraction",
    label: "frames drawing no detection",
    unit: "",
    better: "lower",
    noise: 0.005,
    read: (report) => report.blanking?.nullDetectionFraction,
  },
  {
    key: "blanking.unpreparedFraction",
    label: "frames drawn unprepared",
    unit: "",
    better: "lower",
    noise: 0.02,
    read: (report) => report.blanking?.unpreparedFraction,
  },
  {
    key: "drag.lagP95Seconds",
    label: "drag picture lag p95",
    unit: "s",
    better: "lower",
    /* Bimodal at 0.03s or 1.7s to 3.4s on the same gesture, so a percentage
     * only means something once the median of three passes has settled on one
     * mode. Until the split closes this metric reports the drift and the
     * scenario's own limit is what fails. */
    noise: 3.5,
    read: (report) => report.drag?.lagP95Seconds,
  },
  {
    key: "drag.holdP95Ms",
    label: "drag stale hold p95",
    unit: "ms",
    better: "lower",
    noise: 70,
    read: (report) => report.drag?.holdP95Ms,
  },
  {
    key: "drag.holdMaxMs",
    label: "drag longest stale hold",
    unit: "ms",
    better: "lower",
    noise: 200,
    read: (report) => report.drag?.holdMaxMs,
  },
  {
    key: "drag.framesPerSecond",
    label: "drag frames reaching screen",
    unit: "/s",
    better: "higher",
    noise: 15,
    read: (report) => report.drag?.framesPerSecond,
  },
  {
    key: "drag.releaseMs",
    label: "drag release",
    unit: "ms",
    better: "lower",
    noise: 60,
    read: (report) => report.drag?.releaseMs,
  },
  {
    key: "playhead.stoppedDriftPercent",
    label: "playhead drift while stopped",
    unit: "%",
    better: "lower",
    noise: 0.05,
    read: (report) => report.playhead?.stoppedDriftPercent,
  },
  {
    key: "playhead.worstDisagreementPercent",
    label: "playhead vs picture disagreement",
    unit: "%",
    better: "lower",
    noise: 0.2,
    read: (report) => report.playhead?.worstDisagreementPercent,
  },
  {
    key: "backscrub.maskInkRatio",
    label: "backward-scrub mask ink",
    unit: "x forward",
    better: "higher",
    noise: 0.05,
    read: (report) => report.backscrub?.maskInkRatio,
  },
  {
    key: "backscrub.settleP95Ms",
    label: "backward-scrub settle p95",
    unit: "ms",
    better: "lower",
    noise: 100,
    read: (report) => report.backscrub?.backward?.settleP95Ms,
  },
  {
    key: "focus.dimmedFractionDelta",
    label: "focus dim added",
    unit: "",
    better: "higher",
    noise: 0.01,
    read: (report) => report.focus?.dimmedFractionDelta,
  },
  {
    key: "focus.cutoutFraction",
    label: "focus cutout left bright",
    unit: "",
    better: "higher",
    noise: 0.01,
    read: (report) => report.focus?.cutoutFraction,
  },
  {
    key: "hotkeys.answeredFraction",
    label: "hotkeys answering after a click",
    unit: "",
    better: "higher",
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
