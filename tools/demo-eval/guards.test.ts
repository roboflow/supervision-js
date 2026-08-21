import { describe, expect, it } from "vitest";

import {
  judgeBackscrub,
  judgeBlanking,
  judgeDrag,
  judgeFocus,
  judgeHotkeys,
  judgePlayhead,
  summariseBlanking,
  summariseDrag,
} from "./scenarios-guards.mjs";
import { judgeCadence } from "./scenarios.mjs";

/* Every guard is checked twice: once against numbers a healthy player
 * produces, and once against the signature of the defect it exists for. A gate
 * that has never been shown to fail is not a gate, which is how this codebase
 * spent weeks reporting a paint budget that could not be exceeded. */

const DURATION = 70;

interface DragSample {
  at: number;
  pointerX: number | null;
  scrubValue: number;
  currentTime: number;
  playbackState: string;
  renderCount: number;
}

interface EnginePaint {
  tMs: number;
  mediaTimeMs: number;
  targetMs: number;
}

interface DragProbeOptions {
  samples?: number;
  renderEvery?: number;
  stallFrom?: number;
  stallSamples?: number;
  playbackState?: string;
  landsOnRelease?: boolean;
  paintsBehind?: number;
}

/* The probe's clock and the engine's are two different `performance.now`
 * origins joined on the wall clock they share, so the fixture arms the capture
 * a tenth of a second before the press and stamps its paints against that. */
const TIME_ORIGIN = 1_700_000_000_000;
const ARMED_AT = 900;

function buildProbe({
  samples = 60,
  renderEvery = 1,
  stallFrom = -1,
  stallSamples = 0,
  playbackState = "paused",
  landsOnRelease = true,
  paintsBehind = 0,
}: DragProbeOptions = {}) {
  const downAt = 1000;
  const stepMs = 16;
  const drag: DragSample[] = [];
  const paints: EnginePaint[] = [];
  let renderCount = 0;
  let frozenTime = 0;

  const positionAt = (index: number) => (DURATION * index) / samples;

  for (let index = 0; index < samples; index += 1) {
    const scrubValue = positionAt(index);
    const at = downAt + index * stepMs;
    const stalled =
      index % renderEvery !== 0 ||
      (stallFrom >= 0 &&
        index >= stallFrom &&
        index < stallFrom + stallSamples);
    if (!stalled) {
      renderCount += 1;
      frozenTime = positionAt(Math.max(0, index - paintsBehind));
      paints.push({
        tMs: at - ARMED_AT,
        mediaTimeMs: frozenTime * 1000,
        targetMs: scrubValue * 1000,
      });
    }
    drag.push({
      at,
      pointerX: 100 + index,
      scrubValue,
      currentTime: frozenTime,
      playbackState,
      renderCount,
    });
  }

  const releaseTarget = drag.at(-1)!.scrubValue;
  const upAt = downAt + samples * stepMs;
  const tail: DragSample[] = [
    {
      at: upAt + 120,
      pointerX: 100 + samples,
      scrubValue: releaseTarget,
      currentTime: landsOnRelease ? releaseTarget : 3,
      playbackState,
      renderCount: renderCount + 1,
    },
  ];

  return {
    downAt,
    upAt,
    timeOrigin: TIME_ORIGIN,
    samples: [...drag, ...tail],
    capture: {
      originWallMs: TIME_ORIGIN + ARMED_AT,
      paints,
    },
  };
}

const summarise = (options?: DragProbeOptions) => {
  const probe = buildProbe(options);
  return summariseDrag(probe, {
    capture: probe.capture,
    frameRate: 30,
    startedPaused: true,
  });
};

const withResume = (
  scenario: Record<string, unknown>,
  advancedSeconds = 0.9,
) => ({
  ...scenario,
  resumeAfterRelease: {
    advancedSeconds,
    renderDelta: 27,
    playbackState: "playing",
  },
});

describe("annotations blanking during playback", () => {
  const healthy = Array.from({ length: 100 }, () => ({
    preparedAhead: 205,
    detectionTime: 4.2,
    detectionCount: 13,
    activePrepared: true,
  }));

  it("passes a run where the cook stays ahead and every frame carries detections", () => {
    expect(judgeBlanking(summariseBlanking(healthy))).toEqual([]);
  });

  /* The measured shape of the defect: the cook never got ahead of the
   * playhead and the boxes went out on a third of the sampled frames. */
  it("fails the run that shipped, and names all three numbers", () => {
    const broken = healthy.map((sample, index) => ({
      ...sample,
      preparedAhead: 0,
      activePrepared: index % 3 !== 0,
      detectionTime: index % 3 === 0 ? null : sample.detectionTime,
    }));
    const failures = judgeBlanking(summariseBlanking(broken));
    expect(failures).toHaveLength(3);
    expect(failures.join(" ")).toContain("0 frames ahead");
    expect(failures.join(" ")).toContain("drew no detection");
    expect(failures.join(" ")).toContain("before their masks were cooked");
  });

  it("counts a frame drawn before its masks were cooked", () => {
    const summary = summariseBlanking([
      {
        preparedAhead: 100,
        detectionTime: 1,
        detectionCount: 3,
        activePrepared: false,
      },
      {
        preparedAhead: 100,
        detectionTime: 1,
        detectionCount: 3,
        activePrepared: true,
      },
    ]);
    expect(summary.unpreparedFraction).toBe(0.5);
  });
});

describe("a drag of the timeline", () => {
  it("passes a drag whose picture keeps up with the thumb", () => {
    const scenario = withResume(summarise());
    expect(scenario.lagP95Seconds).toBeLessThan(1);
    expect(scenario.holdP95Ms).toBeLessThanOrEqual(32);
    expect(judgeDrag(scenario)).toEqual([]);
  });

  /* The stale-frame hold: the pointer keeps moving while the screen keeps one
   * frame, which is what a superseded decode being discarded looked like. */
  it("finds the longest frame the screen held while the thumb kept moving", () => {
    const scenario = summarise({ stallFrom: 20, stallSamples: 25 });
    expect(scenario.holdMaxMs).toBeGreaterThan(380);
    expect(scenario.holdP95Ms).toBeLessThan(380);
  });

  it("fails a drag that froze on one frame in the middle of it", () => {
    const scenario = summarise({ samples: 90, stallFrom: 5, stallSamples: 70 });
    expect(judgeDrag(withResume(scenario)).join(" ")).toContain(
      "froze on one frame",
    );
  });

  /* A hold that never gets long enough to look like a freeze but happens on
   * every frame is the same defect spread thin, and the p95 is what sees it. */
  it("fails a drag that held every frame a little too long", () => {
    const scenario = summarise({ renderEvery: 20 });
    expect(scenario.holdMaxMs).toBeLessThan(600);
    const failures = judgeDrag(withResume(scenario));
    expect(failures.join(" ")).toContain("held one frame for 320ms at p95");
  });

  /* The defect the lag number exists for, and the one the other three cannot
   * see: the screen keeps painting at a healthy rate and never holds a frame
   * long, and every frame it paints is from seconds ago. */
  it("fails a drag whose paints all landed seconds behind their target", () => {
    const scenario = summarise({ paintsBehind: 8 });
    expect(scenario.lagP95Seconds).toBeCloseTo(9.333, 3);
    expect(scenario.holdP95Ms).toBeLessThanOrEqual(32);
    expect(scenario.framesPerSecond).toBeGreaterThan(30);
    const failures = judgeDrag(withResume(scenario));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("behind the position they were serving");
  });

  /* The one the lag number cannot see: nothing painted at all, so there is no
   * paint to be behind. Reporting a healthy zero there is what a metric that
   * cannot fail looks like, so it reports nothing and the holds fail instead. */
  it("says nothing about lag across a drag that painted nothing", () => {
    const scenario = summarise({ stallFrom: 0, stallSamples: 60 });
    expect(scenario.paintsMeasured).toBe(0);
    expect(scenario.lagP95Seconds).toBeNull();
    const failures = judgeDrag(withResume(scenario));
    expect(failures.join(" ")).not.toContain("behind the position");
    expect(failures.join(" ")).toContain("froze on one frame");
  });

  /* Two clocks that never met report a lag off unrelated moments, so the
   * gesture is refused rather than turned into a number. */
  it("refuses a capture that does not overlap the gesture", () => {
    const probe = buildProbe();
    expect(() =>
      summariseDrag(probe, {
        capture: {
          ...probe.capture,
          originWallMs: probe.capture.originWallMs + 60_000,
        },
        frameRate: 30,
        startedPaused: true,
      }),
    ).toThrow(/line up on the wall clock/);
  });

  it("fails a release that never landed on the position it was let go at", () => {
    const scenario = summarise({ landsOnRelease: false });
    expect(scenario.releaseMs).toBeNull();
    expect(judgeDrag(withResume(scenario)).join(" ")).toContain(
      "the gesture did not end",
    );
  });

  /* The chip read Playing through a drag the transport had mechanically
   * paused, so the state the player reported was not the state it was in. */
  it("fails a drag that reported Playing while the transport was paused", () => {
    const scenario = summarise({ playbackState: "playing" });
    expect(scenario.misreportedStateSamples).toBe(60);
    expect(judgeDrag(withResume(scenario)).join(" ")).toContain(
      "reported Playing",
    );
  });

  /* The lost release left the producer paused for good: the UI came back but
   * the picture never moved again. */
  it("fails when play after the release does not move the clock", () => {
    const failures = judgeDrag(withResume(summarise(), 0));
    expect(failures.join(" ")).toContain("still holding the drag's pause");
  });
});

describe("the timeline playhead", () => {
  const stopped = {
    holdSeconds: 4,
    stoppedDriftPercent: 0,
    playingDuringHold: 0,
    worstDisagreementPercent: 0.03,
  };

  it("passes a playhead that stands still while the picture stands still", () => {
    expect(judgePlayhead(stopped)).toEqual([]);
  });

  it("fails a playhead that kept running with the picture stopped", () => {
    const failures = judgePlayhead({ ...stopped, stoppedDriftPercent: 5.6 });
    expect(failures.join(" ")).toContain("the picture never moved");
  });

  it("fails a playhead drawn away from the time it is drawing", () => {
    const failures = judgePlayhead({
      ...stopped,
      worstDisagreementPercent: 4.2,
    });
    expect(failures.join(" ")).toContain(
      "away from where the media time puts it",
    );
  });

  it("fails a hold the transport spent claiming to play", () => {
    expect(
      judgePlayhead({ ...stopped, playingDuringHold: 12 }).join(" "),
    ).toContain("reported Playing");
  });
});

describe("scrubbing backwards", () => {
  const stop = (requested: number, ratio: number) => ({
    requested,
    forwardInk: 0.2,
    backwardInk: round(0.2 * ratio),
    ratio,
  });
  const prepared = (requested: number) => ({ requested, prepared: true });
  const healthy = {
    inkByStop: [stop(20, 1), stop(30, 0.98), stop(40, 1.02)],
    maskInkRatio: 0.98,
    forward: { stops: [prepared(20), prepared(30), prepared(40)] },
    backward: { stops: [prepared(40), prepared(30), prepared(20)] },
  };

  it("passes when the backward pass draws what the forward pass drew", () => {
    expect(judgeBackscrub(healthy)).toEqual([]);
  });

  /* Masks arriving forwards and not backwards is the defect. */
  it("fails the stop where the masks did not come back", () => {
    const failures = judgeBackscrub({
      ...healthy,
      inkByStop: [stop(20, 1), stop(30, 0.08), stop(40, 1)],
      maskInkRatio: 0.08,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("at 30s");
    expect(failures[0]).toContain("0.08");
  });

  it("fails a stop on either pass that never finished preparing", () => {
    const failures = judgeBackscrub({
      ...healthy,
      backward: { stops: [prepared(40), { requested: 30, prepared: false }] },
    });
    expect(failures.join(" ")).toContain(
      "backwards at 30s never finished preparing",
    );
  });

  it("refuses to pass a comparison with nothing on the forward side", () => {
    const failures = judgeBackscrub({
      inkByStop: [
        { requested: 20, forwardInk: 0, backwardInk: 0, ratio: null },
      ],
      maskInkRatio: null,
      forward: { stops: [prepared(20)] },
      backward: { stops: [prepared(20)] },
    });
    expect(failures.join(" ")).toContain("drew no coloured ink");
  });
});

describe("the focus overlay", () => {
  const healthy = { dimmedFractionDelta: 0.41, cutoutFraction: 0.12 };

  it("passes an overlay that dims the scene and cuts its subject out of it", () => {
    expect(judgeFocus(healthy)).toEqual([]);
  });

  /* What actually shipped: the overlay stopped drawing at all rather than
   * losing its cutout, so nothing on screen changed when focus came on. */
  it("fails an overlay that did not draw", () => {
    expect(
      judgeFocus({ ...healthy, dimmedFractionDelta: 0.001 }).join(" "),
    ).toContain("the overlay did not draw");
  });

  it("fails an overlay that dimmed its own subject", () => {
    expect(judgeFocus({ ...healthy, cutoutFraction: 0 }).join(" ")).toContain(
      "dimmed its own subject",
    );
  });
});

describe("shortcuts after a layer toggle takes focus", () => {
  const check = (key: string, answered: boolean) => ({
    key,
    expected: "playback starts",
    answered,
    detail: "paused -> paused",
  });

  it("passes when every key still answers", () => {
    expect(
      judgeHotkeys({
        focusedAfterClick: "INPUT:checkbox",
        checks: [check("Space", true), check("Period", true)],
      }),
    ).toEqual([]);
  });

  /* A checkbox holds focus after a click. Treating it as a typing surface
   * retired every shortcut the hint bar still advertised. */
  it("names the key that died and what was holding focus", () => {
    const failures = judgeHotkeys({
      focusedAfterClick: "INPUT:checkbox",
      checks: [check("Space", false), check("Period", true)],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Space");
    expect(failures[0]).toContain("INPUT:checkbox");
  });
});

/* The keypoint fixture runs 9s at 30.00/s. Forty passes of the demo produced
 * the shape below: a whole-clip window from 0.3s whose first and last media
 * seconds are partial, and a late-start window from 4.5s whose last one holds a
 * single interval and is too thin to be a rate. */
const CADENCE_SOURCE_FPS = 30.002;
const CADENCE_FLOOR_FPS = 27;
const CADENCE_HOLD_LIMIT_MS = 66.7;
const CADENCE_MIN_INTERVALS = 8;
/* 29.97/s, the rate a healthy media second reads on this machine. */
const HEALTHY_PERIOD_MS = 33.37;
/* The stall held frames for 101 to 123ms. */
const STALL_PERIOD_MS = 112;
/* Under the 66.7ms hold budget and still slow enough to leave its media second
 * at 20/s. */
const SLOW_PERIOD_MS = 50;
const WHOLE_CLIP: Array<[number, number]> = [
  [0, 20],
  [1, 30],
  [2, 30],
  [3, 30],
  [4, 30],
  [5, 30],
  [6, 30],
  [7, 30],
  [8, 16],
];
const LATE_START: Array<[number, number]> = [
  [4, 13],
  [5, 30],
  [6, 30],
  [7, 30],
  [8, 1],
];

interface MediaSecond {
  second: number;
  intervals: number;
  periodMs: number;
}

interface CadenceShape {
  periodFor?: (second: number) => number;
  intervalsFor?: (second: number, intervals: number) => number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/* A window is built from the frame period each media second ran at, so its
 * bucket rates, its two window rates and its held-frame count all come out of
 * one cadence and cannot disagree with each other. */
function cadenceWindow(
  name: string,
  startSeconds: number,
  spanSeconds: number,
  seconds: MediaSecond[],
) {
  const intervals = seconds.reduce(
    (total, media) => total + media.intervals,
    0,
  );
  const wallMs = seconds.reduce(
    (total, media) => total + media.intervals * media.periodMs,
    0,
  );
  const fps = round2(intervals / (wallMs / 1000));
  return {
    name,
    startSeconds,
    spanSeconds,
    consumer: {
      fps,
      presentedFrames: intervals + 1,
      wallSeconds: round(wallMs / 1000),
      mediaAdvancedSeconds: round(wallMs / 1000),
    },
    engine: {
      fps,
      paints: intervals + 1,
      lateFrames: 0,
      stalls: 0,
      maxCatchUpMs: 7,
      longestHoldMs: Math.max(...seconds.map((media) => media.periodMs)),
      skips: seconds
        .filter((media) => media.periodMs > CADENCE_HOLD_LIMIT_MS)
        .reduce((total, media) => total + media.intervals, 0),
      backwardPaints: 0,
    },
    disagreementFps: 0,
    buckets: seconds.map((media) => ({
      second: media.second,
      intervals: media.intervals,
      fps: round2(1000 / media.periodMs),
      longestHoldMs: media.periodMs,
      judged: media.intervals >= CADENCE_MIN_INTERVALS,
    })),
  };
}

function cadenceScenario({
  periodFor = () => HEALTHY_PERIOD_MS,
  intervalsFor = (_second, intervals) => intervals,
}: CadenceShape = {}) {
  const plan = (entries: Array<[number, number]>) =>
    entries.map(([second, intervals]) => ({
      second,
      intervals: intervalsFor(second, intervals),
      periodMs: periodFor(second),
    }));
  const windows = [
    cadenceWindow("whole-clip", 0.3, 8.2, plan(WHOLE_CLIP)),
    cadenceWindow("late-start", 4.5, 3.5, plan(LATE_START)),
  ];
  const judged = new Set(
    windows.flatMap((window) =>
      window.buckets
        .filter((bucket) => bucket.judged)
        .map((bucket) => bucket.second),
    ),
  );
  const owed = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return {
    sourceRateFps: CADENCE_SOURCE_FPS,
    floorFraction: 0.9,
    floorFps: CADENCE_FLOOR_FPS,
    holdPeriods: 2,
    holdLimitMs: CADENCE_HOLD_LIMIT_MS,
    skipLimit: 0,
    lateFrameFraction: 0.02,
    agreementLimitFps: 1.5,
    minBucketIntervals: CADENCE_MIN_INTERVALS,
    coverage: {
      fromSecond: 0,
      toSecond: 8,
      judgedSeconds: owed.filter((second) => judged.has(second)),
      missingSeconds: owed.filter((second) => !judged.has(second)),
    },
    windows,
  };
}

describe("the keypoint fixture's cadence", () => {
  it("passes a clip that held its rate in every media second of it", () => {
    const scenario = cadenceScenario();
    expect(scenario.coverage.missingSeconds).toEqual([]);
    expect(judgeCadence(scenario)).toEqual([]);
  });

  /* The stall as it was diagnosed: 33ms a frame up to media 4 and 101 to 123ms
   * past it, positional and not cumulative. */
  it("names every media second past the mark the stall appeared at", () => {
    const failures = judgeCadence(
      cadenceScenario({
        periodFor: (second) =>
          second >= 4 ? STALL_PERIOD_MS : HEALTHY_PERIOD_MS,
      }),
    );
    const named = failures.filter((failure) => failure.includes("at media "));
    expect(named).toHaveLength(9);
    for (const second of [4, 5, 6, 7, 8]) {
      expect(named.join(" ")).toContain(`at media ${second}s`);
    }
    for (const second of [0, 1, 2, 3]) {
      expect(named.join(" ")).not.toContain(`at media ${second}s`);
    }
    expect(failures.join(" ")).toContain("held 136 frames longer than 66.7ms");
  });

  /* One media second slow enough to fail the floor and never holding a frame
   * past the budget. Both window clocks average it away and the held-frame
   * count never moves, so the per-media-second reading is the only one that
   * sees it: this is the gate the scenario exists for. */
  it("fails one slow media second that both window clocks average away", () => {
    const scenario = cadenceScenario({
      periodFor: (second) =>
        second === 8 ? SLOW_PERIOD_MS : HEALTHY_PERIOD_MS,
    });
    for (const window of scenario.windows) {
      expect(window.consumer.fps).toBeGreaterThan(CADENCE_FLOOR_FPS);
      expect(window.engine.fps).toBeGreaterThan(CADENCE_FLOOR_FPS);
      expect(window.engine.skips).toBe(0);
      expect(window.engine.longestHoldMs).toBeLessThan(CADENCE_HOLD_LIMIT_MS);
    }
    const failures = judgeCadence(scenario);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("presented 20/s at media 8s");
  });

  it("fails a run that judged the clip in part", () => {
    const failures = judgeCadence(
      cadenceScenario({
        intervalsFor: (second, intervals) => (second === 4 ? 3 : intervals),
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("media second 4");
    expect(failures[0]).toContain("judged in part");
  });
});

function round(value: number) {
  return Math.round(value * 10000) / 10000;
}
