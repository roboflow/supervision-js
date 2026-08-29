import { describe, expect, it } from "vitest";

import {
  METRICS,
  buildBaseline,
  compareProvenance,
  compareToBaseline,
  median,
  readMetrics,
  recordingGaps,
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

  /* A loud instrument produces enormous percentages from changes it makes on
   * its own, which is how a drift gate turns into noise nobody reads. The step
   * p95 is the loudest here: thirty-six passes of one build spread 30.2ms. */
  it("ignores a large percentage on a change smaller than the noise floor", () => {
    const { rows } = compareToBaseline(
      { "latency.step.p95": 70 },
      baselineOf({ "latency.step.p95": 45 }),
    );
    expect(rowFor(rows, "latency.step.p95").percent).toBe(55.6);
    expect(rowFor(rows, "latency.step.p95").verdict).toBe("steady");
  });

  it("still catches a move past the noise floor", () => {
    const { rows } = compareToBaseline(
      { "latency.step.p95": 90 },
      baselineOf({ "latency.step.p95": 45 }),
    );
    expect(rowFor(rows, "latency.step.p95").verdict).toBe("regressed");
  });

  /* The floor is the whole gate on a metric the baseline recorded as zero,
   * because a percentage off zero is not a number and the tolerance is skipped
   * for it. */
  it("reports the first sampled frame that drew no detection", () => {
    const { rows } = compareToBaseline(
      { "blanking.nullDetectionFraction": 0.005 },
      baselineOf({ "blanking.nullDetectionFraction": 0 }),
    );
    expect(rowFor(rows, "blanking.nullDetectionFraction").verdict).toBe(
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
      { "backscrub.maskInkRatio": 0.75, "throttle.coverage": 0.97 },
      baselineOf({ "backscrub.maskInkRatio": 1, "throttle.coverage": 1 }),
    );
    expect(rowFor(rows, "backscrub.maskInkRatio").verdict).toBe("regressed");
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

/* The release lands inside 7ms on seventeen passes in twenty-two and takes 40
 * to 93ms on the other five, with nothing in the pass to tell the two apart, so
 * the floor has to clear the slow mode whole. */
describe("the drag release floor", () => {
  const recorded = baselineOf({ "drag.releaseMs": 5 });

  it("swallows the slow mode one unchanged build lands on", () => {
    const { rows } = compareToBaseline({ "drag.releaseMs": 93 }, recorded);
    expect(rowFor(rows, "drag.releaseMs").verdict).toBe("steady");
  });

  it("reports a release slower than anything that build produced", () => {
    const { rows, regressions } = compareToBaseline(
      { "drag.releaseMs": 100 },
      recorded,
    );
    expect(rowFor(rows, "drag.releaseMs").verdict).toBe("regressed");
    expect(regressions).toHaveLength(1);
  });
});

/* Both of these sit on one number every pass, so their floor is the whole gate
 * and a percentage tolerance beside it is what would swallow the defect: a
 * quarter off either one lands past the value its own scenario fails at, 0.9 in
 * both cases. A full run measured the ink at exactly 1.000 on thirty-six passes
 * and the throttled picture between 0.984 and 1.002 on thirty-four. */
describe("the two gates a fixed answer leaves to the floor alone", () => {
  it("reports a throttled picture thinned to the scenario's own floor", () => {
    const { rows } = compareToBaseline(
      { "throttle.presentedRateFraction": 0.9 },
      baselineOf({ "throttle.presentedRateFraction": 0.989 }),
    );
    expect(rowFor(rows, "throttle.presentedRateFraction").verdict).toBe(
      "regressed",
    );
  });

  it("leaves the spread one build produces on its own alone", () => {
    const { rows } = compareToBaseline(
      { "throttle.presentedRateFraction": 0.988 },
      baselineOf({ "throttle.presentedRateFraction": 0.997 }),
    );
    expect(rowFor(rows, "throttle.presentedRateFraction").verdict).toBe(
      "steady",
    );
  });

  it("reports the first thousandth of backward-scrub ink that goes missing", () => {
    const { rows } = compareToBaseline(
      { "backscrub.maskInkRatio": 0.999 },
      baselineOf({ "backscrub.maskInkRatio": 1 }),
    );
    expect(rowFor(rows, "backscrub.maskInkRatio").verdict).toBe("regressed");
  });
});

/* Twenty-three passes of a full run read 51 to 57ms and a twenty-fourth 80ms
 * while a test suite ran beside it, against a 200ms ceiling. The floor covers
 * the band, and a quarter of the band's own middle is what reports above it. */
describe("the throttled long-task floor", () => {
  const recorded = baselineOf({ "throttle.longTaskMaxMs": 52 });

  it("leaves the band one build sits in alone", () => {
    const { rows } = compareToBaseline(
      { "throttle.longTaskMaxMs": 57 },
      recorded,
    );
    expect(rowFor(rows, "throttle.longTaskMaxMs").verdict).toBe("steady");
  });

  it("reports a longest task past anything that band produced", () => {
    const { rows } = compareToBaseline(
      { "throttle.longTaskMaxMs": 66 },
      recorded,
    );
    expect(rowFor(rows, "throttle.longTaskMaxMs").verdict).toBe("regressed");
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

describe("the tree the numbers came from", () => {
  const clean = {
    source: { consumer: { commit: "abc1234", dirty: false } },
    fixture: { id: "horse_trail", label: "70s horse trail" },
  };

  it("says nothing when both sides are the same commit and the same clip", () => {
    expect(compareProvenance(clean, { ...clean })).toEqual([]);
  });

  it("names both commits when the baseline was recorded on other code", () => {
    const [warning, ...rest] = compareProvenance(clean, {
      ...clean,
      source: { consumer: { commit: "def5678", dirty: false } },
    });
    expect(rest).toEqual([]);
    expect(warning).toContain("abc1234");
    expect(warning).toContain("def5678");
  });

  it("reports a comparison where either tree carried uncommitted changes", () => {
    const [recorded] = compareProvenance(
      { ...clean, source: { consumer: { commit: "abc1234", dirty: true } } },
      clean,
    );
    expect(recorded).toContain("the baseline");
    const [measured] = compareProvenance(clean, {
      ...clean,
      source: { consumer: { commit: "abc1234", dirty: true } },
    });
    expect(measured).toContain("this run");
  });

  it("reports a checkout only one side fingerprints", () => {
    const [warning] = compareProvenance(
      {
        ...clean,
        source: {
          ...clean.source,
          engine: { commit: "9f9f9f9", dirty: false },
        },
      },
      clean,
    );
    expect(warning).toContain("engine");
    expect(warning).toContain("9f9f9f9");
  });

  it("reports a comparison taken on a different clip", () => {
    const [warning] = compareProvenance(clean, {
      ...clean,
      fixture: { id: "basketball_sam3", label: "9s basketball sample" },
    });
    expect(warning).toContain("horse_trail");
    expect(warning).toContain("basketball_sam3");
  });

  it("reports a baseline that never recorded a clip at all", () => {
    const [warning] = compareProvenance({ ...clean, fixture: null }, clean);
    expect(warning).toContain("does not record which clip");
  });
});

/* A run that cannot say what it measured is not a baseline, it is a set of
 * numbers, and every later run holds itself against it and reports the gap as
 * drift in the library. */
describe("recording a baseline", () => {
  const recordable = {
    fixture: { id: "horse_trail", label: "70s horse trail" },
    runs: 1,
    media: "70.4s at 30fps",
    viewMode: "demo",
    source: { consumer: { commit: "abc1234", dirty: false } },
    values: { "latency.seek.p95": 45 },
  };

  it("keeps what a later comparison needs", () => {
    const baseline = buildBaseline(recordable);

    expect(baseline.fixture).toEqual(recordable.fixture);
  });

  it("refuses to record a run that cannot name its clip", () => {
    expect(() => buildBaseline({ ...recordable, fixture: null })).toThrow(
      /which clip it ran on/,
    );
  });

  it("names every gap so one run reports them all", () => {
    expect(recordingGaps({})).toEqual(["which clip it ran on"]);
    expect(recordingGaps(recordable)).toEqual([]);
  });
});

/* Four sessions of an unchanged build put this between 0.1595 and 0.1628, and
 * resizing the window alone carries it to 0.1678 inside one session, so a
 * budget wider than a tenth is wider than anything the metric does on its own.
 * A quarter of it is a third of the dim. */
describe("the focus dim budget", () => {
  it("reports a dim a fifth weaker than the baseline it is measured against", () => {
    const { rows, regressions } = compareToBaseline(
      { "focus.dimmedFractionDelta": 0.1597 },
      baselineOf({ "focus.dimmedFractionDelta": 0.2083 }),
    );
    expect(rowFor(rows, "focus.dimmedFractionDelta").verdict).toBe("regressed");
    expect(regressions).toHaveLength(1);
  });

  it("leaves the step between two sessions of one build alone", () => {
    const { rows } = compareToBaseline(
      { "focus.dimmedFractionDelta": 0.1595 },
      baselineOf({ "focus.dimmedFractionDelta": 0.1628 }),
    );
    expect(rowFor(rows, "focus.dimmedFractionDelta").verdict).toBe("steady");
  });
});
