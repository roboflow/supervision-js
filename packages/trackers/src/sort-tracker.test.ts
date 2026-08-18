import { describe, expect, it } from "vitest";
import { createSortTracker } from "./index";

const detection = (
  detectionIndex: number,
  x: number,
  className = "person",
  confidence?: number,
) => ({
  className,
  ...(confidence === undefined ? {} : { confidence }),
  detectionIndex,
  rect: { height: 20, width: 10, x, y: 10 },
});

describe("createSortTracker", () => {
  it("keeps new tracks unconfirmed and allocates zero-based IDs on confirmation", () => {
    const tracker = createSortTracker();

    expect(tracker.update([detection(0, 10)], 0).assignments).toEqual([]);
    expect(tracker.update([detection(0, 11)], 1).assignments).toEqual([]);
    expect(tracker.update([detection(0, 12)], 2).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("does not assign an ID on the spawn frame when confirmation is one", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 1 });

    const spawned = tracker.update([detection(0, 10)], 0);
    expect(spawned.assignments).toEqual([]);
    expect(spawned.confirmedTrackCount).toBe(0);

    expect(tracker.update([detection(0, 10)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("keeps identity across motion and input-order changes", () => {
    const tracker = createSortTracker();
    tracker.update([detection(0, 10), detection(1, 100)], 0);
    tracker.update([detection(0, 11), detection(1, 99)], 1);
    const confirmed = tracker.update([detection(0, 98), detection(1, 12)], 2);

    expect(confirmed.assignments).toEqual([
      { detectionIndex: 0, trackerId: 1 },
      { detectionIndex: 1, trackerId: 0 },
    ]);
  });

  it("associates classes exactly like Python SORT", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 2 });
    tracker.update([detection(0, 10, "person")], 0);

    expect(
      tracker.update([detection(0, 10, "basketball")], 1).assignments,
    ).toEqual([{ detectionIndex: 0, trackerId: 0 }]);
  });

  it("uses confidence only to activate unmatched tracks", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 2 });

    expect(
      tracker.update([detection(0, 10, "person", 0.24)], 0).activeTrackCount,
    ).toBe(0);
    expect(
      tracker.update([detection(0, 10, "person", 0.25)], 1).assignments,
    ).toEqual([]);
    expect(
      tracker.update([detection(0, 10, "person", 0.1)], 2).assignments,
    ).toEqual([{ detectionIndex: 0, trackerId: 0 }]);
  });

  it("treats missing confidence as 1", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 2 });
    tracker.update([detection(0, 10)], 0);

    expect(tracker.update([detection(0, 10)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("removes an immature track on its first miss", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 3 });
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([], 1).activeTrackCount).toBe(0);

    tracker.update([detection(0, 10)], 2);
    tracker.update([detection(0, 10)], 3);
    expect(tracker.update([detection(0, 10)], 4).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("supports a zero lost-track buffer", () => {
    const tracker = createSortTracker({
      lostTrackBuffer: 0,
      minimumConsecutiveFrames: 2,
    });
    tracker.update([detection(0, 10)], 0);
    tracker.update([detection(0, 10)], 1);

    expect(tracker.update([], 2).activeTrackCount).toBe(0);
    tracker.update([detection(0, 10)], 3);
    expect(tracker.update([detection(0, 10)], 4).assignments).toEqual([
      { detectionIndex: 0, trackerId: 1 },
    ]);
  });

  it("scales lost-track retention by frame rate", () => {
    const tracker = createSortTracker({
      frameRate: 60,
      lostTrackBuffer: 1,
      minimumConsecutiveFrames: 2,
    });
    tracker.update([detection(0, 10)], 0);
    tracker.update([detection(0, 10)], 1);

    expect(tracker.update([], 2).activeTrackCount).toBe(1);
    expect(tracker.update([], 3).activeTrackCount).toBe(1);
    expect(tracker.update([], 4).activeTrackCount).toBe(0);
  });

  it("keeps motion predictions internal while reassociating across gaps", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 2 });
    tracker.update([detection(0, 10)], 0);
    expect(tracker.update([detection(0, 12)], 1).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);

    const gap = tracker.update([], 2);

    expect(gap.assignments).toEqual([]);
    expect(gap.activeTrackCount).toBe(1);
    expect(tracker.update([detection(0, 16)], 3).assignments).toEqual([
      { detectionIndex: 0, trackerId: 0 },
    ]);
  });

  it("resets both tracks and the instance-local ID allocator", () => {
    const tracker = createSortTracker({ minimumConsecutiveFrames: 2 });
    tracker.update([detection(0, 10)], 0);
    expect(
      tracker.update([detection(0, 10)], 1).assignments[0]!.trackerId,
    ).toBe(0);

    tracker.reset();
    tracker.update([detection(0, 10)], 0);
    expect(
      tracker.update([detection(0, 10)], 1).assignments[0]!.trackerId,
    ).toBe(0);
  });

  it("rejects invalid direct tracker options", () => {
    expect(() => createSortTracker({ lostTrackBuffer: -1 })).toThrow(
      "lostTrackBuffer must be a non-negative integer",
    );
    expect(() => createSortTracker({ frameRate: 0 })).toThrow(
      "frameRate must be a finite positive value",
    );
    expect(() =>
      createSortTracker({
        frameRate: Number.MAX_VALUE,
        lostTrackBuffer: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("Scaled lostTrackBuffer overflows");
    expect(() => createSortTracker({ minimumIouThreshold: 1.1 })).toThrow(
      "minimumIouThreshold must be between 0 and 1",
    );
  });
});
