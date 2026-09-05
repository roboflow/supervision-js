import { describe, expect, it } from "vitest";

import { createBufferedDetectionTimeline } from "#detections/buffered-detection-timeline";
import type { DetectionFrameSource } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

/* Frames as a chunked source hands them out after a cache eviction: same
   content, new objects every load. */
function makeFrames(): DetectionFrame[] {
  return Array.from({ length: 12 }, (_, index) => ({
    detections: [
      {
        className: "a",
        id: `d${index}`,
        rect: { height: 2, width: 2, x: 1, y: 1 },
      },
    ],
    frameIndex: index,
    mediaTime: index / 10,
  }));
}

function makeSource(version = 0): DetectionFrameSource & { bump(): void } {
  let current = version;
  return {
    bump() {
      current += 1;
    },
    getVersion() {
      return current;
    },
    loadFrames(startTime, endTime) {
      return Promise.resolve(
        makeFrames().filter(
          (f) => f.mediaTime >= startTime && f.mediaTime <= endTime,
        ),
      );
    },
  };
}

describe("buffered detection timeline snapshot identity", () => {
  it("hands back the same frame object after the frame leaves the window and returns", async () => {
    const source = makeSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 0.25,
      bufferBehindSeconds: 0.05,
      source,
    });

    await timeline.prepare(0.1);
    const first = timeline.selectFrame(0.1);
    expect(first?.frameIndex).toBe(1);

    await timeline.prepare(0.9);
    expect(timeline.selectFrame(0.1)).toBeUndefined();

    await timeline.prepare(0.1);
    const again = timeline.selectFrame(0.1);

    expect(again).toBe(first);
    timeline.destroy();
  });

  it("hands back a new object once the source version changes", async () => {
    const source = makeSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 0.25,
      bufferBehindSeconds: 0.05,
      source,
    });

    await timeline.prepare(0.1);
    const before = timeline.selectFrame(0.1);

    source.bump();
    await timeline.prepare(0.9);
    await timeline.prepare(0.1);
    const after = timeline.selectFrame(0.1);

    expect(after).not.toBe(before);
    expect(after?.frameIndex).toBe(1);
    timeline.destroy();
  });
});
