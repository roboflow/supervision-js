import { describe, expect, it } from "vitest";

import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import type { DetectionFrame } from "#types/detections";

const frame0: DetectionFrame = {
  detections: [{ id: "zero" }],
  endTime: 1,
  frameIndex: 0,
  mediaTime: 0,
};

const frame1: DetectionFrame = {
  detections: [{ id: "one" }],
  endTime: 2,
  frameIndex: 1,
  mediaTime: 1,
};

const replacementFrame1: DetectionFrame = {
  detections: [{ id: "one-replaced" }],
  endTime: 2,
  frameIndex: 1,
  mediaTime: 1,
};

describe("memory cold detection frame store", () => {
  it("stores, merges, loads, and clears detection frames without persistence", async () => {
    const store = createMemoryColdDetectionFrameStore();

    await expect(
      store.putFrames({
        chunkDurationSeconds: 1,
        datasetId: "memory",
        frames: [frame0],
      }),
    ).resolves.toMatchObject({
      chunkCount: 1,
      detectionCount: 1,
      endTime: 1,
      frameCount: 1,
      startTime: 0,
    });

    await expect(
      store.appendFrames({
        datasetId: "memory",
        frames: [frame1, replacementFrame1],
      }),
    ).resolves.toMatchObject({
      detectionCount: 2,
      endTime: 2,
      frameCount: 2,
      startTime: 0,
    });

    await expect(
      store.loadFrames({ datasetId: "memory", startTime: 0.5, endTime: 2 }),
    ).resolves.toEqual([frame0, replacementFrame1]);

    await store.clearDataset("memory");

    await expect(
      store.loadFrames({ datasetId: "memory", startTime: 0, endTime: 2 }),
    ).resolves.toEqual([]);
  });

  it("loads only indexed chunks while preserving out-of-order replacements", async () => {
    const store = createMemoryColdDetectionFrameStore();
    const generatedFrames = Array.from({ length: 300 }, (_, frameIndex) => ({
      detections: [{ id: `frame-${frameIndex}` }],
      endTime: (frameIndex + 1) / 30,
      frameIndex,
      mediaTime: frameIndex / 30,
    }));

    for (let offset = generatedFrames.length; offset > 0; offset -= 30) {
      await store.appendFrames({
        chunkDurationSeconds: 1,
        datasetId: "chunked",
        frames: generatedFrames.slice(Math.max(0, offset - 30), offset),
      });
    }

    const replacement = {
      ...generatedFrames[151]!,
      detections: [{ id: "replacement" }],
    };
    const summary = await store.appendFrames({
      datasetId: "chunked",
      frames: [replacement],
    });
    const loadedFrames = await store.loadFrames({
      datasetId: "chunked",
      endTime: 5.2,
      startTime: 5,
    });

    expect(summary).toMatchObject({
      chunkCount: 10,
      detectionCount: 300,
      endTime: 10,
      frameCount: 300,
      startTime: 0,
    });
    expect(loadedFrames.map((frame) => frame.frameIndex)).toEqual([
      150, 151, 152, 153, 154, 155, 156,
    ]);
    expect(loadedFrames.find((frame) => frame.frameIndex === 151)).toEqual(
      replacement,
    );
  });

  it("updates summary bounds when a boundary frame moves", async () => {
    const store = createMemoryColdDetectionFrameStore();

    await store.putFrames({
      datasetId: "bounds",
      frames: [frame0, frame1],
    });

    await expect(
      store.appendFrames({
        datasetId: "bounds",
        frames: [
          {
            ...frame1,
            endTime: 1.75,
            mediaTime: 1.5,
          },
        ],
      }),
    ).resolves.toMatchObject({
      endTime: 1.75,
      frameCount: 2,
      startTime: 0,
    });
  });

  it("prunes frames that end before the retention floor", async () => {
    const store = createMemoryColdDetectionFrameStore();

    await store.putFrames({
      datasetId: "stream",
      frames: [
        { detections: [{ id: "a" }], endTime: 1, mediaTime: 0 },
        { detections: [{ id: "b" }], endTime: 2, mediaTime: 1 },
        { detections: [{ id: "c" }], endTime: 3, mediaTime: 2 },
      ],
    });

    await expect(
      store.pruneFrames?.({ datasetId: "stream", startTime: 2 }),
    ).resolves.toMatchObject({
      detectionCount: 1,
      endTime: 3,
      frameCount: 1,
      startTime: 2,
    });
    await expect(
      store.loadFrames({ datasetId: "stream", endTime: 3, startTime: 0 }),
    ).resolves.toEqual([
      { detections: [{ id: "c" }], endTime: 3, mediaTime: 2 },
    ]);
  });

  it("clears its bounds when pruning removes every frame", async () => {
    const store = createMemoryColdDetectionFrameStore();

    await store.putFrames({
      datasetId: "stream",
      frames: [{ detections: [{ id: "a" }], endTime: 1, mediaTime: 0 }],
    });

    await expect(
      store.pruneFrames?.({ datasetId: "stream", startTime: 5 }),
    ).resolves.toMatchObject({
      detectionCount: 0,
      endTime: null,
      frameCount: 0,
      startTime: null,
    });
  });

  it("reports an empty summary when pruning an unknown dataset", async () => {
    const store = createMemoryColdDetectionFrameStore();

    await expect(
      store.pruneFrames?.({ datasetId: "missing", startTime: 1 }),
    ).resolves.toMatchObject({ datasetId: "missing", frameCount: 0 });
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    "rejects the retention floor %p without touching stored frames",
    async (startTime) => {
      const store = createMemoryColdDetectionFrameStore();
      const frames = [
        { detections: [{ id: "a" }], endTime: 1, mediaTime: 0 },
        { detections: [{ id: "b" }], endTime: 2, mediaTime: 1 },
      ];

      await store.putFrames({ datasetId: "stream", frames });

      await expect(
        store.pruneFrames?.({ datasetId: "stream", startTime }),
      ).rejects.toThrow(
        "pruneFrames requires a finite, non-negative startTime.",
      );
      await expect(
        store.loadFrames({ datasetId: "stream", endTime: 2, startTime: 0 }),
      ).resolves.toEqual(frames);
    },
  );
});
