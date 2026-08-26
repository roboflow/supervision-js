import { describe, expect, it } from "vitest";

import type { DetectionFrame } from "supervision-js-core";

import { createPreparedWindowTimeline } from "./prepared-window-timeline";

function createFrame(frameIndex: number, mediaTime: number): DetectionFrame {
  return {
    detections: [],
    frameIndex,
    mediaTime,
  };
}

describe("createPreparedWindowTimeline", () => {
  it("returns loop-aware window keys across a looping media boundary", () => {
    const timeline = createPreparedWindowTimeline({
      getFrameKey: (frame) => `${frame.frameIndex}`,
    });
    const frames = [0, 1, 2, 3, 4].map((frameIndex) =>
      createFrame(frameIndex, frameIndex * 0.25),
    );

    timeline.setContext({ duration: 1, loop: true });
    timeline.rememberFrames(frames, new Set(["0", "1", "2", "3", "4"]));

    expect(timeline.getWindowFrameKeys(0.75, 3)).toEqual(["3", "0", "4"]);
    expect(timeline.getWindowFrameKeys(0, 2)).toEqual(["0", "4"]);
  });

  it("returns forward-only window keys for non-looping timelines", () => {
    const timeline = createPreparedWindowTimeline({
      getFrameKey: (frame) => `${frame.frameIndex}`,
    });
    const frames = [0, 1, 2, 3].map((frameIndex) =>
      createFrame(frameIndex, frameIndex * 0.25),
    );

    timeline.setContext({ duration: 1, loop: false });
    timeline.rememberFrames(frames, new Set(["0", "1", "2", "3"]));

    expect(timeline.getWindowFrameKeys(0.5, 2)).toEqual(["2", "3"]);
    expect(timeline.getWindowFrameKeys(0.5, 10)).toEqual(["2", "3"]);
    expect(timeline.getWindowFrameKeys(0.5, 0)).toEqual([]);
  });

  it("measures wrapped-ahead frames as near and just-passed frames as far", () => {
    const timeline = createPreparedWindowTimeline({
      getFrameKey: (frame) => `${frame.frameIndex}`,
    });

    timeline.setContext({ duration: 10, loop: true });

    expect(timeline.getFrameDistance(0, 9.75)).toBeCloseTo(0.25);
    expect(timeline.getFrameDistance(0.75, 9.75)).toBeCloseTo(1);
    expect(timeline.getFrameDistance(9.5, 9.75)).toBeCloseTo(9.75);

    timeline.setContext({ duration: null, loop: false });

    expect(timeline.getFrameDistance(9.9, 9.75)).toBeCloseTo(0.15);
    expect(timeline.getFrameDistance(9.5, 9.75)).toBe(0);
  });
});
