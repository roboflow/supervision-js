import { describe, expect, it } from "vitest";

import {
  advanceMediaClockBudget,
  createMediaClockBudget,
  MEDIA_CLOCK_LATE_TOLERANCE_MS,
  resolveMediaClockDecision,
  resolveMediaClockDueAt,
  type MediaClockBudget,
} from "./media-clock-policy";

// A 30fps clip whose first frame was pinned at wall time 1000.
const anchorMs = 1000;
const anchorPts = 0;
const FRAME_INTERVAL_MS = 1000 / 30;

function decide(
  timestampMs: number,
  nowMs: number,
  budget: MediaClockBudget = createMediaClockBudget(),
) {
  return resolveMediaClockDecision({
    anchorMs,
    anchorPts,
    budget,
    nowMs,
    timestampMs,
  });
}

describe("resolveMediaClockDecision", () => {
  it("presents and infers when nothing has been measured yet", () => {
    // Frame 3 is due at 1100; the pump reached it at 1080. With no measured
    // inference cost the first run is always affordable, or nothing would
    // ever infer.
    expect(decide(100, 1080)).toEqual({
      shouldDrop: false,
      shouldInfer: true,
      slackMs: 20,
    });
  });

  it("presents without inferring when the budget cannot cover the last run", () => {
    const decision = decide(100, 1080, { lastInferenceMs: 688, spareMs: 100 });

    expect(decision.shouldDrop).toBe(false);
    expect(decision.shouldInfer).toBe(false);
  });

  it("infers again once the banked wait covers the measured price", () => {
    const decision = decide(100, 1080, { lastInferenceMs: 688, spareMs: 700 });

    expect(decision.shouldInfer).toBe(true);
  });

  it("drops a frame whose moment has passed", () => {
    const decision = decide(100, 1100 + MEDIA_CLOCK_LATE_TOLERANCE_MS + 1);

    expect(decision.shouldDrop).toBe(true);
    expect(decision.shouldInfer).toBe(false);
  });

  it("keeps a frame exactly at the tolerance boundary", () => {
    expect(decide(100, 1100 + MEDIA_CLOCK_LATE_TOLERANCE_MS).shouldDrop).toBe(
      false,
    );
  });

  it("never infers on a frame it is dropping, however rich the budget", () => {
    const decision = decide(100, 5000, {
      lastInferenceMs: 10,
      spareMs: 100_000,
    });

    expect(decision.shouldDrop).toBe(true);
    expect(decision.shouldInfer).toBe(false);
  });
});

describe("advanceMediaClockBudget", () => {
  it("banks waiting time", () => {
    expect(
      advanceMediaClockBudget({
        budget: { lastInferenceMs: 50, spareMs: 10 },
        inferenceMs: 0,
        inferred: false,
        waitedMs: 17,
      }),
    ).toEqual({ lastInferenceMs: 50, spareMs: 27 });
  });

  it("spends the bank and records the real price when inference runs", () => {
    expect(
      advanceMediaClockBudget({
        budget: { lastInferenceMs: 50, spareMs: 700 },
        inferenceMs: 688,
        inferred: true,
        waitedMs: 0,
      }),
    ).toEqual({ lastInferenceMs: 688, spareMs: 12 });
  });

  it("never banks negative time from a late frame", () => {
    expect(
      advanceMediaClockBudget({
        budget: { lastInferenceMs: 0, spareMs: 5 },
        inferenceMs: 0,
        inferred: false,
        waitedMs: -40,
      }).spareMs,
    ).toBe(5);
  });
});

/**
 * Walks a clip the way the pump does. Returns what a viewer would experience.
 */
function simulate(options: {
  readonly frames: number;
  readonly inferenceMs: number;
  readonly presentMs: number;
}) {
  let now = anchorMs;
  let budget = createMediaClockBudget();
  let presented = 0;
  let dropped = 0;
  const inferredAt: number[] = [];

  for (let index = 0; index < options.frames; index += 1) {
    const timestampMs = index * FRAME_INTERVAL_MS;
    const decision = resolveMediaClockDecision({
      anchorMs,
      anchorPts,
      budget,
      nowMs: now,
      timestampMs,
    });

    if (decision.shouldDrop) {
      dropped += 1;
      continue;
    }

    const waitedMs = Math.max(0, decision.slackMs);

    now += waitedMs;

    if (decision.shouldInfer) {
      now += options.inferenceMs;
      inferredAt.push(index);
    }

    now += options.presentMs;
    presented += 1;
    budget = advanceMediaClockBudget({
      budget,
      inferenceMs: decision.shouldInfer ? options.inferenceMs : 0,
      inferred: decision.shouldInfer,
      waitedMs,
    });
  }

  return {
    dropped,
    elapsedMs: now - anchorMs,
    inferredAt,
    presented,
  };
}

describe("media clock pacing", () => {
  it("keeps video watchable when inference costs far more than a frame", () => {
    // Roughly a Pixel 10 Pro: 688ms per model run against a 33ms frame.
    // Spending inference on every on-time frame would present about one frame
    // per run, which is correct duration and unwatchable video.
    //
    // Two thirds is the structural ceiling here, not a tuning choice. Each
    // presented frame banks 33 - 16 = 17ms, so covering a 688ms run takes ~40
    // frames, and the run itself passes ~21 frames that a single-threaded pump
    // cannot present while it is busy. Forty presented per sixty-one is ~66%,
    // or about 20fps of a 30fps clip. Getting closer to every frame means
    // presenting while inferring, which needs concurrency rather than a
    // different rule here.
    const result = simulate({ frames: 300, inferenceMs: 688, presentMs: 16 });

    expect(result.presented / 300).toBeGreaterThan(0.6);
    // Inference still happens, just rarely enough to leave room to present.
    expect(result.inferredAt.length).toBeGreaterThan(1);
    expect(result.inferredAt.length).toBeLessThan(20);
  });

  it("infers far more often when the model is cheap", () => {
    const cheap = simulate({ frames: 300, inferenceMs: 40, presentMs: 16 });
    const expensive = simulate({
      frames: 300,
      inferenceMs: 688,
      presentMs: 16,
    });

    // The cadence follows the measured price rather than a fixed constant.
    expect(cheap.inferredAt.length).toBeGreaterThan(
      expensive.inferredAt.length * 3,
    );
  });

  it("holds the clip to its own duration", () => {
    const frames = 300;
    const result = simulate({ frames, inferenceMs: 688, presentMs: 16 });
    const clipMs = frames * FRAME_INTERVAL_MS;

    // Within one inference of the real running time: the clip does not stretch
    // to inference speed, which is the whole point of the media clock.
    expect(result.elapsedMs).toBeLessThan(clipMs + 688);
    expect(result.elapsedMs).toBeGreaterThan(clipMs * 0.9);
  });

  it("presents consecutive frames between model runs", () => {
    const result = simulate({ frames: 300, inferenceMs: 688, presentMs: 16 });

    // Gaps between inferences are long, which is what a viewer sees as motion.
    for (let index = 1; index < result.inferredAt.length; index += 1) {
      expect(
        result.inferredAt[index]! - result.inferredAt[index - 1]!,
      ).toBeGreaterThan(5);
    }
  });
});

describe("resolveMediaClockDueAt", () => {
  it("offsets the anchor by the frame's distance from the first timestamp", () => {
    expect(
      resolveMediaClockDueAt({ anchorMs, anchorPts: 500, timestampMs: 600 }),
    ).toBe(1100);
  });
});
