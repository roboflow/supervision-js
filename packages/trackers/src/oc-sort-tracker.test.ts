import { describe, expect, it } from "vitest";
import { createOCSortTracker } from "./index";

const detection = (detectionIndex: number, x: number, confidence = 0.9) => ({
  confidence,
  detectionIndex,
  rect: { height: 20, width: 10, x, y: 10 },
});

describe("createOCSortTracker", () => {
  it("matches the observation-centric ID trace from roboflow/trackers 60b21c8", () => {
    const tracker = createOCSortTracker();

    expect(
      tracker.update([detection(0, 10, 0.9), detection(1, 100, 0.95)], 0)
        .assignments,
    ).toEqual([]);
    expect(
      tracker.update([detection(0, 99, 0.8), detection(1, 12, 0.85)], 1)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 0 },
    ]);
    expect(
      tracker.update([detection(0, 15, 0.8), detection(1, 96, 0.8)], 2)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 0 },
      { detectionIndex: 1, trackerId: 1 },
    ]);
  });

  it("recovers a confirmed observation after a missed frame", () => {
    const tracker = createOCSortTracker();
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([detection(0, 11)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
    expect(tracker.update([], 2).assignments).toEqual([]);
    expect(tracker.update([detection(0, 13)], 3).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("keeps an allocated ID private until a recovered track is mature again", () => {
    const tracker = createOCSortTracker({ minimumConsecutiveFrames: 3 });
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([detection(0, 11)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
    tracker.update([], 2);
    tracker.update([], 3);

    expect(tracker.update([detection(0, 12)], 4).assignments).toEqual([]);
    expect(tracker.update([detection(0, 13)], 5).assignments).toEqual([]);
    expect(tracker.update([detection(0, 14)], 6).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("never associates or spawns from detections below the high-confidence threshold", () => {
    const tracker = createOCSortTracker();
    expect(tracker.update([detection(0, 10, 0.59)], 0)).toMatchObject({
      activeTrackCount: 0,
      assignments: [],
      confirmedTrackCount: 0,
    });
  });

  it("treats missing confidence as eligible for association", () => {
    const tracker = createOCSortTracker();
    const withoutConfidence = (x: number) => ({
      detectionIndex: 0,
      rect: { height: 20, width: 10, x, y: 10 },
    });
    tracker.update([withoutConfidence(10)], 0);
    expect(tracker.update([withoutConfidence(11)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("resets state and its zero-based ID allocator", () => {
    const tracker = createOCSortTracker();
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([detection(0, 11)], 1).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });
    tracker.reset();
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([detection(0, 11)], 1).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });
  });

  it("validates OC-SORT-specific options", () => {
    expect(() => createOCSortTracker({ deltaT: 0 })).toThrow(
      "deltaT must be a positive integer",
    );
    expect(() =>
      createOCSortTracker({ directionConsistencyWeight: 1.1 }),
    ).toThrow("directionConsistencyWeight must be between 0 and 1");
  });
});
