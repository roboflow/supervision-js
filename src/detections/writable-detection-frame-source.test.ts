import { describe, expect, it, vi } from "vitest";

import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

const summary: ColdDetectionFrameStoreWriteSummary = {
  chunkCount: 1,
  chunkDurationSeconds: 1,
  datasetId: "dataset",
  detectionCount: 1,
  endTime: 0,
  frameCount: 1,
  startTime: 0,
};

const frames: DetectionFrame[] = [
  {
    detections: [{ id: "box" }],
    frameIndex: 0,
    mediaTime: 0,
  },
];

describe("writable detection frame source", () => {
  it("delegates appends to cold storage and increments its version", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      chunkDurationSeconds: 1,
      datasetId: "dataset",
      store,
    });

    await source.appendFrames(frames);

    expect(store.appendFrames).toHaveBeenCalledWith({
      chunkDurationSeconds: 1,
      datasetId: "dataset",
      frames,
    });
    expect(source.getSummary()).toEqual(summary);
    expect(source.getVersion()).toBe(1);
  });

  it("loads ranges from cold storage", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await expect(source.loadFrames(0, 1)).resolves.toEqual(frames);
    expect(store.loadFrames).toHaveBeenCalledWith({
      datasetId: "dataset",
      endTime: 1,
      startTime: 0,
    });
  });

  it("clears storage and increments its version", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await source.clear();

    expect(store.clearDataset).toHaveBeenCalledWith("dataset");
    expect(source.getSummary()).toBeNull();
    expect(source.getVersion()).toBe(1);
  });

  it("only increments range versions for appended frame ranges", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await source.appendFrames([
      {
        detections: [{ id: "late" }],
        frameIndex: 90,
        mediaTime: 3,
      },
    ]);

    expect(source.getVersion({ endTime: 1, startTime: 0 })).toBe(0);
    expect(source.getVersion({ endTime: 4, startTime: 2 })).toBe(1);
    expect(source.getVersion()).toBe(1);
  });

  it("waits until appended frames cover a requested range", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });
    let resolved = false;
    const waitForRange = source
      .waitForRange({ endTime: 2, startTime: 0 })
      .then(() => {
        resolved = true;
      });

    await source.appendFrames([
      {
        detections: [],
        endTime: 2,
        frameIndex: 1,
        mediaTime: 1,
      },
    ]);
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(source.getAvailableRanges()).toEqual([{ endTime: 2, startTime: 1 }]);

    await source.appendFrames([
      {
        detections: [],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
    ]);
    await waitForRange;

    expect(resolved).toBe(true);
    expect(source.getAvailableRanges()).toEqual([{ endTime: 2, startTime: 0 }]);
  });
});

function createStore(): ColdDetectionFrameStore {
  return {
    appendFrames: vi.fn(async () => summary),
    clearDataset: vi.fn(async () => undefined),
    loadFrames: vi.fn(async () => frames),
    putFrames: vi.fn(async () => summary),
  };
}
