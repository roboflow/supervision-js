import { describe, expect, it } from "vitest";
import { createCBIoUTracker } from "./index";

const detection = (detectionIndex: number, x: number, confidence = 0.9) => ({
  confidence,
  detectionIndex,
  rect: { height: 20, width: 10, x, y: 10 },
});

describe("createCBIoUTracker", () => {
  it("matches the multi-stage ID trace from roboflow/trackers 60b21c8", () => {
    const tracker = createCBIoUTracker();

    expect(
      tracker.update([detection(0, 10, 0.9), detection(1, 100, 0.95)], 0)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 0 },
      { detectionIndex: 1, trackerId: 1 },
    ]);
    expect(
      tracker.update([detection(0, 99, 0.8), detection(1, 12, 0.4)], 1)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 0 },
    ]);
    expect(
      tracker.update([detection(0, 15, 0.8), detection(1, 96, 0.3)], 2)
        .assignments,
    ).toEqual([
      { detectionIndex: 0, trackerId: 0 },
      { detectionIndex: 1, trackerId: 1 },
    ]);
    expect(tracker.update([], 3).assignments).toEqual([]);
    expect(
      tracker.update([detection(0, 22, 0.4), detection(1, 90, 0.85)], 4)
        .assignments,
    ).toEqual([{ detectionIndex: 1, trackerId: 1 }]);
  });

  it("uses buffered IoU to recover a fast-moving detection", () => {
    const buffered = createCBIoUTracker();
    const plain = createCBIoUTracker({
      bufferRatioFirst: 0,
      bufferRatioSecond: 0,
    });

    buffered.update([detection(0, 10)], 0);
    plain.update([detection(0, 10)], 0);

    expect(buffered.update([detection(0, 18)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
    expect(plain.update([detection(0, 18)], 1).assignments).toEqual([]);
  });

  it("never creates tracks from low or discarded detections", () => {
    const tracker = createCBIoUTracker();

    expect(
      tracker.update([detection(0, 10, 0.4), detection(1, 20, 0.1)], 0),
    ).toMatchObject({
      activeTrackCount: 0,
      assignments: [],
      confirmedTrackCount: 0,
    });
  });

  it("resets first-frame activation and the zero-based ID allocator", () => {
    const tracker = createCBIoUTracker();
    expect(tracker.update([detection(0, 10)], 0).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });

    tracker.reset();
    expect(tracker.update([detection(0, 10)], 0).assignments[0]).toEqual({
      detectionIndex: 0,
      trackerId: 0,
    });
  });

  it("validates C-BIoU-specific options", () => {
    expect(() => createCBIoUTracker({ bufferRatioFirst: -0.1 })).toThrow(
      "bufferRatioFirst must be a finite non-negative value",
    );
    expect(() =>
      createCBIoUTracker({ minimumIouThresholdSecondAssociation: 1.1 }),
    ).toThrow("minimumIouThresholdSecondAssociation must be between 0 and 1");
  });
});
