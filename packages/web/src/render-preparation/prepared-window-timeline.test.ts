import { expect, it } from "vitest";
import { createPreparedWindowTimeline } from "./prepared-window-timeline";

it("orders prepared frames through the absolute [2, 5.4] loop", () => {
  const timeline = createPreparedWindowTimeline({
    getFrameKey: (frame) => String(frame.mediaTime),
  });
  const frames = [2, 2.4, 5.2].map((mediaTime) => ({
    mediaTime,
    detections: [],
  }));
  timeline.setContext({ firstTimestamp: 2, duration: 3.4, loop: true });
  timeline.rememberFrames(
    frames,
    new Set(frames.map((frame) => String(frame.mediaTime))),
  );
  expect(
    timeline.getWindowFrames(frames, 5.1).map((frame) => frame.mediaTime),
  ).toEqual([5.2, 2, 2.4]);
  expect(timeline.getFrameDistance(5.2, 5.1)).toBeCloseTo(0.1);
  expect(timeline.getFrameDistance(2, 5.2)).toBeCloseTo(0.2);
});
