import { describe, expect, it } from "vitest";
import { createSortTracker } from "./sort-tracker";

const detection = (
  detectionIndex: number,
  x: number,
  className = "person",
) => ({
  className,
  detectionIndex,
  rect: { height: 20, width: 10, x, y: 10 },
});

describe("createSortTracker", () => {
  it("keeps identity across motion and input-order changes", () => {
    const tracker = createSortTracker();
    const first = tracker.update([detection(0, 10), detection(1, 100)], 0);
    const second = tracker.update([detection(0, 98), detection(1, 12)], 1);

    expect(first.assignments).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 2 },
    ]);
    expect(second.assignments).toEqual([
      { detectionIndex: 0, trackerId: 2 },
      { detectionIndex: 1, trackerId: 1 },
    ]);
  });

  it("does not associate different classes by default", () => {
    const tracker = createSortTracker();
    tracker.update([detection(0, 10, "person")], 0);

    expect(tracker.update([detection(0, 10, "ball")], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 2 },
    ]);
  });

  it("expires tracks after maxAge", () => {
    const tracker = createSortTracker({ maxAge: 1 });
    tracker.update([detection(0, 10)], 0);
    tracker.update([], 1);
    tracker.update([], 2);

    expect(tracker.update([detection(0, 10)], 3).assignments).toEqual([
      { detectionIndex: 0, trackerId: 2 },
    ]);
  });

  it("emits motion predictions for confirmed tracks across gaps", () => {
    const tracker = createSortTracker({ minHits: 2 });
    tracker.update([detection(0, 10)], 0);
    tracker.update([detection(0, 12)], 1);

    const gap = tracker.update([], 2);

    expect(gap.assignments).toEqual([]);
    expect(gap.predictions).toHaveLength(1);
    expect(gap.predictions[0]).toMatchObject({
      ageFrames: 1,
      className: "person",
      trackerId: 1,
    });
    expect(gap.predictions[0]!.rect.x).toBeGreaterThan(12);
  });

  it("does not predict unconfirmed tracks and stops after maxAge", () => {
    const unconfirmed = createSortTracker({ minHits: 2 });
    unconfirmed.update([detection(0, 10)], 0);
    expect(unconfirmed.update([], 1).predictions).toEqual([]);

    const expiring = createSortTracker({ maxAge: 1, minHits: 1 });
    expiring.update([detection(0, 10)], 0);
    expect(expiring.update([], 1).predictions).toHaveLength(1);
    expect(expiring.update([], 2).predictions).toEqual([]);
  });

  it("can disable prediction emission without changing track survival", () => {
    const tracker = createSortTracker({
      emitPredictions: false,
      minHits: 1,
    });
    tracker.update([detection(0, 10)], 0);

    const gap = tracker.update([], 1);

    expect(gap.activeTrackCount).toBe(1);
    expect(gap.predictions).toEqual([]);
  });

  it("rejects invalid direct tracker options", () => {
    expect(() => createSortTracker({ maxAge: 0 })).toThrow(
      "maxAge must be a positive integer",
    );
    expect(() => createSortTracker({ iouThreshold: 1.1 })).toThrow(
      "iouThreshold must be between 0 and 1",
    );
  });
});
