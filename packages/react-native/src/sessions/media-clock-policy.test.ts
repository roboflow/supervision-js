import { describe, expect, it } from "vitest";

import {
  MEDIA_CLOCK_LATE_TOLERANCE_MS,
  resolveMediaClockDecision,
  resolveMediaClockDueAt,
} from "./media-clock-policy";

// A 30fps clip whose first frame was pinned at wall time 1000.
const anchorMs = 1000;
const anchorPts = 0;

function decide(timestampMs: number, nowMs: number) {
  return resolveMediaClockDecision({
    anchorMs,
    anchorPts,
    nowMs,
    timestampMs,
  });
}

describe("resolveMediaClockDecision", () => {
  it("presents and infers when the frame is not yet due", () => {
    // Frame 3 is due at 1100; the pump reached it at 1080.
    expect(decide(100, 1080)).toEqual({
      shouldDrop: false,
      shouldInfer: true,
      slackMs: 20,
    });
  });

  it("presents without inferring once the schedule has been spent", () => {
    // Slightly late: still worth showing, but there is no budget for a model
    // run, so this frame reuses the held detections.
    const decision = decide(100, 1110);

    expect(decision.shouldDrop).toBe(false);
    expect(decision.shouldInfer).toBe(false);
    expect(decision.slackMs).toBe(-10);
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

  it("never infers on a frame it is dropping", () => {
    // Paying for a result nobody sees is what compounds the delay.
    const decision = decide(100, 5000);

    expect(decision.shouldDrop).toBe(true);
    expect(decision.shouldInfer).toBe(false);
  });

  it("self-regulates: one inference is followed by cheap catch-up frames", () => {
    // Walk a 30fps clip where inference costs 72ms and presenting costs 16ms.
    const inferenceMs = 72;
    const presentMs = 16;
    let now = anchorMs;
    const inferred: number[] = [];
    const dropped: number[] = [];

    for (let index = 0; index < 12; index += 1) {
      const timestampMs = (index * 1000) / 30;
      const decision = decide(timestampMs, now);

      if (decision.shouldDrop) {
        dropped.push(index);
        continue;
      }

      if (decision.slackMs > 0) {
        now += decision.slackMs;
      }

      now += decision.shouldInfer ? inferenceMs + presentMs : presentMs;

      if (decision.shouldInfer) {
        inferred.push(index);
      }
    }

    // Inference happens periodically rather than every frame or once.
    expect(inferred.length).toBeGreaterThan(1);
    expect(inferred.length).toBeLessThan(12);
    // Two inferences never land back to back: the first spends the slack.
    for (let index = 1; index < inferred.length; index += 1) {
      expect(inferred[index]! - inferred[index - 1]!).toBeGreaterThan(1);
    }
    // Playback stays on the media timeline instead of running long.
    const lastTimestampMs = (11 * 1000) / 30;
    expect(now - anchorMs).toBeLessThan(lastTimestampMs + inferenceMs * 2);
    expect(dropped.length).toBeLessThan(12);
  });
});

describe("resolveMediaClockDueAt", () => {
  it("offsets the anchor by the frame's distance from the first timestamp", () => {
    expect(
      resolveMediaClockDueAt({ anchorMs, anchorPts: 500, timestampMs: 600 }),
    ).toBe(1100);
  });
});
