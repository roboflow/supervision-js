import { describe, expect, it } from "vitest";

import type { DetectionFrame } from "supervision-js-core";

import { createPreparedWindowTimeline } from "./prepared-window-timeline";

const HORSE_TRAIL_DURATION_SECONDS = 70.4233;
const HORSE_TRAIL_FRAME_PITCH_SECONDS = 1 / 30.004;
const HORSE_TRAIL_PLAYHEAD_SECONDS = 107 * HORSE_TRAIL_FRAME_PITCH_SECONDS;

function createFrames(frameCount: number, framePitchSeconds: number) {
  return Array.from({ length: frameCount }, (_, frameIndex) => ({
    detections: [],
    frameIndex,
    mediaTime: frameIndex * framePitchSeconds,
  })) satisfies DetectionFrame[];
}

function createLoopingTimeline(duration: number) {
  const timeline = createPreparedWindowTimeline();

  timeline.setContext({ duration, loop: true });

  return timeline;
}

describe("prepared window timeline", () => {
  it("orders a looping window by the travel the playhead still owes each frame", () => {
    const timeline = createLoopingTimeline(0.4);

    expect(
      timeline
        .getWindowFrames(createFrames(10, 0.04), 0.28, 5)
        .map((frame) => frame.frameIndex),
    ).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("leaves out the frames the buffer no longer reaches ahead of the playhead", () => {
    const timeline = createLoopingTimeline(HORSE_TRAIL_DURATION_SECONDS);
    const windowFrames = timeline.getWindowFrames(
      createFrames(340, HORSE_TRAIL_FRAME_PITCH_SECONDS),
      HORSE_TRAIL_PLAYHEAD_SECONDS,
      10.54,
    );

    expect(windowFrames.map((frame) => frame.frameIndex)).toEqual(
      Array.from({ length: 210 }, (_, offset) => 107 + offset),
    );
  });

  it("keeps the frames past the loop point that the buffer already holds", () => {
    const timeline = createLoopingTimeline(1);

    expect(
      timeline
        .getWindowFrames(createFrames(10, 0.1), 0.7, 1.25)
        .map((frame) => frame.frameIndex),
    ).toEqual([7, 8, 9, 0, 1, 2]);
  });

  it("keeps only the frames ahead of the playhead when the media does not loop", () => {
    const timeline = createPreparedWindowTimeline();

    timeline.setContext({ duration: 0.4, loop: false });

    expect(
      timeline
        .getWindowFrames(createFrames(10, 0.04), 0.28, 5)
        .map((frame) => frame.frameIndex),
    ).toEqual([7, 8, 9]);
  });

  it("measures a looping distance forward around the media end", () => {
    const timeline = createLoopingTimeline(HORSE_TRAIL_DURATION_SECONDS);

    expect(
      timeline.getFrameDistance(0, HORSE_TRAIL_PLAYHEAD_SECONDS),
    ).toBeCloseTo(66.8571, 3);
  });
});
