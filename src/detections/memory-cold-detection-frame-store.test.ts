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
});
