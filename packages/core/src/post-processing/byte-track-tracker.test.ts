import { describe, expect, it } from "vitest";
import { createByteTrackTracker } from "./byte-track-tracker";

const detection = (detectionIndex: number, x: number, confidence?: number) => ({
  ...(confidence === undefined ? {} : { confidence }),
  detectionIndex,
  rect: { height: 20, width: 10, x, y: 10 },
});

describe("createByteTrackTracker", () => {
  it("recovers a low-confidence observation in the second association stage", () => {
    const tracker = createByteTrackTracker();

    expect(tracker.update([detection(0, 10, 0.9)], 0).assignments).toEqual([]);
    expect(tracker.update([detection(0, 11, 0.4)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("never spawns a track from an unmatched low-confidence detection", () => {
    const tracker = createByteTrackTracker({ minimumConsecutiveFrames: 1 });

    expect(tracker.update([detection(0, 10, 0.59)], 0)).toMatchObject({
      activeTrackCount: 0,
      assignments: [],
      confirmedTrackCount: 0,
    });
  });

  it("returns but does not activate unmatched high detections below activation", () => {
    const tracker = createByteTrackTracker({ minimumConsecutiveFrames: 1 });

    expect(tracker.update([detection(0, 10, 0.69)], 0).activeTrackCount).toBe(
      0,
    );
    expect(tracker.update([detection(0, 10, 0.7)], 1).activeTrackCount).toBe(1);
  });

  it("treats missing confidence as high confidence and 1.0 activation", () => {
    const tracker = createByteTrackTracker();
    tracker.update([detection(0, 10)], 0);

    expect(tracker.update([detection(0, 11)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("matches both stages class-agnostically while preserving input indexes", () => {
    const tracker = createByteTrackTracker();
    tracker.update([detection(4, 10, 0.9), detection(8, 100, 0.9)], 0);

    expect(
      tracker.update([detection(8, 99, 0.4), detection(4, 11, 0.8)], 1)
        .assignments,
    ).toEqual([
      { detectionIndex: 8, trackerId: 1 },
      { detectionIndex: 4, trackerId: 0 },
    ]);
  });

  it("drops an immature track on a miss and keeps a confirmed ID through a gap", () => {
    const tracker = createByteTrackTracker({ lostTrackBuffer: 2 });
    tracker.update([detection(0, 10, 0.9)], 0);
    expect(tracker.update([], 1).activeTrackCount).toBe(0);

    tracker.update([detection(0, 10, 0.9)], 2);
    expect(tracker.update([detection(0, 11, 0.9)], 3).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
    expect(tracker.update([], 4).activeTrackCount).toBe(1);
    expect(tracker.update([detection(0, 13, 0.4)], 5).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("preserves the final fixed-rate reassociation opportunity", () => {
    const tracker = createByteTrackTracker({
      lostTrackBuffer: 1,
      minimumConsecutiveFrames: 2,
    });
    tracker.update([detection(0, 10, 0.9)], 0);
    expect(tracker.update([detection(0, 11, 0.9)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
    expect(tracker.update([], 2).activeTrackCount).toBe(1);

    expect(tracker.update([detection(0, 13, 0.4)], 3).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("resets track state and its zero-based ID allocator", () => {
    const tracker = createByteTrackTracker();
    tracker.update([detection(0, 10, 0.9)], 0);
    expect(tracker.update([detection(0, 10, 0.9)], 1).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });

    tracker.reset();
    tracker.update([detection(0, 10, 0.9)], 0);
    expect(tracker.update([detection(0, 10, 0.9)], 1).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });
  });

  it("matches the multi-stage ID trace from roboflow/trackers 60b21c8", () => {
    const tracker = createByteTrackTracker();

    expect(
      tracker.update([detection(0, 10, 0.9), detection(1, 100, 0.95)], 0)
        .assignments,
    ).toEqual([]);
    expect(
      tracker.update([detection(0, 99, 0.8), detection(1, 11, 0.4)], 1)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 0 },
      { detectionIndex: 1, trackerId: 1 },
    ]);
    expect(
      tracker.update([detection(0, 12, 0.8), detection(1, 98, 0.3)], 2)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 0 },
    ]);
    expect(tracker.update([], 3).assignments).toEqual([]);
    expect(
      tracker.update([detection(0, 14, 0.4), detection(1, 96, 0.85)], 4)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 0 },
    ]);
  });

  it("validates ByteTrack-specific options", () => {
    expect(() =>
      createByteTrackTracker({ highConfidenceDetectionThreshold: 1.1 }),
    ).toThrow("highConfidenceDetectionThreshold must be between 0 and 1");
    expect(() => createByteTrackTracker({ lostTrackBuffer: -1 })).toThrow(
      "lostTrackBuffer must be a non-negative integer",
    );
  });
});
