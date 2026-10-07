import { describe, expect, it } from "vitest";

import { createBufferedDetectionTimeline } from "#detections/buffered-detection-timeline";
import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
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

  it.each(["inclusive", "exclusive"])(
    "keeps patched snapshots with an %s-end change journal after leaving the window",
    async (journalBounds) => {
      const source = createWritableDetectionFrameSource({
        datasetId: "snapshot-patches",
        store: createMemoryColdDetectionFrameStore(),
      });
      await source.appendFrames(makeFrames());
      const timeline = createBufferedDetectionTimeline({
        bufferAheadSeconds: 0.25,
        bufferBehindSeconds: 0.05,
        source:
          journalBounds === "inclusive"
            ? source
            : {
                ...source,
                getChangesSince(version, ranges) {
                  const changes = source.getChangesSince!(version, ranges);
                  return {
                    ...changes,
                    ranges: changes.ranges.filter((change) =>
                      ranges.some(
                        (range) =>
                          change.startTime < range.endTime &&
                          change.endTime >= range.startTime,
                      ),
                    ),
                  };
                },
              },
      });

      try {
        await timeline.prepare(0.1);
        const unchanged = timeline.selectFrame(0.2);
        await timeline.prepare(0.9);
        const outsideBefore = timeline.selectFrame(1.1);
        await timeline.prepare(0.1);

        await source.appendFrames(
          makeFrames()
            .filter(
              (frame) => frame.frameIndex === 1 || frame.frameIndex === 11,
            )
            .map((frame) => ({
              ...frame,
              detections: [{ ...frame.detections[0], className: "patched" }],
            })),
        );
        await timeline.prepare(0.1);
        const patched = timeline.selectFrame(0.1);
        expect(patched?.detections[0]?.className).toBe("patched");
        expect(timeline.selectFrame(0.2)).toBe(unchanged);

        await timeline.prepare(0.9);
        expect(timeline.selectFrame(1.1)?.detections[0]?.className).toBe(
          "patched",
        );
        expect(timeline.selectFrame(1.1)).not.toBe(outsideBefore);
        await timeline.prepare(0.1);
        expect(timeline.selectFrame(0.1)).toBe(patched);
        expect(timeline.selectFrame(0.2)).toBe(unchanged);
      } finally {
        timeline.destroy();
      }
    },
  );

  it("retains patched and unchanged snapshots when windows have different range versions", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "snapshot-range-versions",
      store: createMemoryColdDetectionFrameStore(),
    });
    await source.appendFrames(makeFrames());
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 0.25,
      bufferBehindSeconds: 0.05,
      source,
    });

    try {
      await timeline.prepare(0.1);
      const unchanged = timeline.selectFrame(0.2);
      await timeline.prepare(0.9);
      const outside = timeline.selectFrame(0.9);
      await timeline.prepare(0.1);
      await source.appendFrames([
        {
          ...makeFrames()[1],
          detections: [
            { ...makeFrames()[1].detections[0], className: "patched" },
          ],
        },
      ]);
      await timeline.prepare(0.1);
      const patched = timeline.selectFrame(0.1);
      expect(patched?.detections[0]?.className).toBe("patched");
      expect(source.getVersion({ startTime: 0.05, endTime: 0.35 })).toBe(2);
      expect(source.getVersion({ startTime: 0.85, endTime: 1.15 })).toBe(1);

      await timeline.prepare(0.9);
      expect(timeline.selectFrame(0.9)).toBe(outside);
      await timeline.prepare(0.1);
      expect(timeline.selectFrame(0.1)).toBe(patched);
      expect(timeline.selectFrame(0.2)).toBe(unchanged);
    } finally {
      timeline.destroy();
    }
  });
});
