import { describe, expect, it } from "vitest";

import {
  METRICS,
  compareToBaseline,
  median,
  readMetrics,
  sameMachine,
  spread,
} from "./baseline.mjs";

interface Row {
  key: string;
  verdict: string;
  percent: number | null;
  current: number | null;
  baseline: number | null;
}

const baselineOf = (metrics: Record<string, number>) => ({
  toleranceDefaultPercent: 25,
  metrics: Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, { value }]),
  ),
});

const rowFor = (rows: Row[], key: string) => {
  const row = rows.find((entry) => entry.key === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};

describe("the metric registry", () => {
  it("names every metric once", () => {
    const keys = METRICS.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every metric a direction and a noise floor", () => {
    for (const metric of METRICS) {
      expect(["lower", "higher"]).toContain(metric.better);
      expect(metric.noise).toBeGreaterThanOrEqual(0);
      expect(typeof metric.read).toBe("function");
    }
  });
});

describe("reading a report", () => {
  it("derives rates the scenarios only report as counts", () => {
    const values = readMetrics({
      paints: { playing: { layoutCount: 88, elapsedSeconds: 6.82 } },
    });
    expect(values["paints.playing.layoutRate"]).toBeCloseTo(12.9, 1);
  });

  it("carries nothing for a scenario that did not run", () => {
    expect(readMetrics({})).toEqual({});
  });

  it("takes the worst detection offset, not the last one", () => {
    const values = readMetrics({
      sync: {
        seeks: [
          { currentToDetectionMs: -2, settleMs: 100 },
          { currentToDetectionMs: 31, settleMs: 120 },
          { currentToDetectionMs: null, settleMs: 140 },
        ],
      },
    });
    expect(values["sync.worstDetectionOffsetMs"]).toBe(31);
    expect(values["sync.worstSettleMs"]).toBe(140);
  });
});

describe("comparing against a baseline", () => {
  it("calls a slower number a regression and says by how much", () => {
    const { rows, regressions } = compareToBaseline(
      { "latency.seek.p95": 90 },
      baselineOf({ "latency.seek.p95": 45 }),
    );
    const row = rowFor(rows, "latency.seek.p95");
    expect(row.verdict).toBe("regressed");
    expect(row.percent).toBe(100);
    expect(regressions).toHaveLength(1);
  });

  it("calls a faster number an improvement", () => {
    const { rows, regressions } = compareToBaseline(
      { "latency.seek.p95": 20 },
      baselineOf({ "latency.seek.p95": 45 }),
    );
    expect(rowFor(rows, "latency.seek.p95").verdict).toBe("improved");
    expect(regressions).toHaveLength(0);
  });

  it("inverts the sense of a metric where higher is better", () => {
    const higher = METRICS.find((metric) => metric.key === "throttle.coverage");
    expect(higher?.better).toBe("higher");
    const { rows } = compareToBaseline(
      { "throttle.coverage": 0.5 },
      baselineOf({ "throttle.coverage": 1 }),
    );
    expect(rowFor(rows, "throttle.coverage").verdict).toBe("regressed");
  });

  it("leaves a move inside the tolerance alone", () => {
    const { rows } = compareToBaseline(
      { "latency.seek.p95": 50 },
      baselineOf({ "latency.seek.p95": 45 }),
    );
    expect(rowFor(rows, "latency.seek.p95").verdict).toBe("steady");
  });

  /* A metric whose baseline is small produces enormous percentages from
   * changes a person would never see, which is how a drift gate turns into
   * noise nobody reads. */
  it("ignores a large percentage on a change smaller than the noise floor", () => {
    const { rows } = compareToBaseline(
      { "paints.playing.styleRecalcRate": 27 },
      baselineOf({ "paints.playing.styleRecalcRate": 23 }),
    );
    expect(rowFor(rows, "paints.playing.styleRecalcRate").percent).toBe(17.4);
    expect(rowFor(rows, "paints.playing.styleRecalcRate").verdict).toBe(
      "steady",
    );
  });

  it("still catches a move past the noise floor on a small baseline", () => {
    const { rows } = compareToBaseline(
      { "paints.playing.styleRecalcRate": 40 },
      baselineOf({ "paints.playing.styleRecalcRate": 23 }),
    );
    expect(rowFor(rows, "paints.playing.styleRecalcRate").verdict).toBe(
      "regressed",
    );
  });

  it("reports a regression away from zero without dividing by it", () => {
    const { rows } = compareToBaseline(
      { "battery.failures": 2 },
      baselineOf({ "battery.failures": 0 }),
    );
    const row = rowFor(rows, "battery.failures");
    expect(row.percent).toBeNull();
    expect(row.verdict).toBe("regressed");
  });

  it("marks a metric the baseline never recorded as new", () => {
    const { rows, regressions } = compareToBaseline(
      { "drag.holdMaxMs": 25 },
      baselineOf({}),
    );
    expect(rowFor(rows, "drag.holdMaxMs").verdict).toBe("new");
    expect(regressions).toHaveLength(0);
  });

  /* A scenario that stopped running is not a scenario that started passing. */
  it("marks a baselined metric this run never measured", () => {
    const { rows } = compareToBaseline(
      {},
      baselineOf({ "drag.holdMaxMs": 25 }),
    );
    expect(rowFor(rows, "drag.holdMaxMs").verdict).toBe("not-measured");
  });

  it("takes the tolerance from the caller over the baseline file", () => {
    const drifted = { "blanking.preparedAheadMedian": 190 };
    const recorded = baselineOf({ "blanking.preparedAheadMedian": 208 });

    expect(
      rowFor(
        compareToBaseline(drifted, recorded).rows,
        "blanking.preparedAheadMedian",
      ).verdict,
    ).toBe("steady");

    const tightened = compareToBaseline(drifted, recorded, {
      tolerancePercent: 4,
    });
    expect(tightened.tolerancePercent).toBe(4);
    expect(rowFor(tightened.rows, "blanking.preparedAheadMedian").verdict).toBe(
      "regressed",
    );
  });

  /* Some numbers have a right answer rather than a budget. One shortcut in
   * four dying is a quarter of them gone, which no tolerance should absorb. */
  it("gives no tolerance at all to a metric that should be exact", () => {
    const { rows } = compareToBaseline(
      { "hotkeys.answeredFraction": 0.75, "throttle.coverage": 0.97 },
      baselineOf({ "hotkeys.answeredFraction": 1, "throttle.coverage": 1 }),
    );
    expect(rowFor(rows, "hotkeys.answeredFraction").verdict).toBe("regressed");
    expect(rowFor(rows, "throttle.coverage").verdict).toBe("regressed");
  });

  it("compares against nothing when there is no baseline file", () => {
    const { rows, regressions } = compareToBaseline(
      { "latency.seek.p95": 45 },
      null,
    );
    expect(rowFor(rows, "latency.seek.p95").verdict).toBe("new");
    expect(regressions).toHaveLength(0);
  });
});

describe("repeated measurements", () => {
  it("takes the median of an odd run and the midpoint of an even one", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("reports the spread so a quiet median cannot hide a loud machine", () => {
    expect(spread([10, 12, 40])).toBe(30);
    expect(spread([10])).toBe(0);
  });
});

describe("the machine the numbers came from", () => {
  it("refuses to call two different processors the same machine", () => {
    const here = { platform: "darwin-arm64", cpu: "M3 Max", cores: 16 };
    expect(sameMachine(here, { ...here })).toBe(true);
    expect(sameMachine(here, { ...here, cpu: "M1" })).toBe(false);
    expect(sameMachine(here, { ...here, cores: 8 })).toBe(false);
    expect(sameMachine(here, null)).toBe(false);
  });
});
