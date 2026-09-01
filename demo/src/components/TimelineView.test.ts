import { describe, expect, it } from "vitest";

import { resolveTimelineTime, settlePendingTimelineSeek } from "./TimelineView";

describe("resolveTimelineTime", () => {
  it("follows the drag while a pointer is down", () => {
    expect(resolveTimelineTime(34.46, null, 0)).toBe(34.46);
  });

  it("stays on a committed seek's target while its picture is still coming", () => {
    // The player keeps reporting the frame on screen through a seek, so falling
    // back to it walks the playhead back to where the viewer started. On a slow
    // source that is most of the wait.
    expect(resolveTimelineTime(null, 34.46, 0)).toBe(34.46);
  });

  it("follows the player once nothing is outstanding", () => {
    expect(resolveTimelineTime(null, null, 12.5)).toBe(12.5);
  });

  it("prefers a new drag over a seek still in flight", () => {
    expect(resolveTimelineTime(58, 34.46, 0)).toBe(58);
  });

  it("reports nothing when the player has not said where it is", () => {
    expect(resolveTimelineTime(null, null, null)).toBe(null);
  });

  it("keeps a target of zero, which is a position and not an absence", () => {
    expect(resolveTimelineTime(null, 0, 47.3)).toBe(0);
  });
});

describe("settlePendingTimelineSeek", () => {
  it("clears the target only when its own seek finishes", () => {
    expect(
      settlePendingTimelineSeek({ runId: 4, target: 34.46 }, 4),
    ).toBeNull();
  });

  it("keeps a newer target when an older seek finishes later", () => {
    const pending = { runId: 5, target: 58 };

    expect(settlePendingTimelineSeek(pending, 4)).toBe(pending);
  });
});
