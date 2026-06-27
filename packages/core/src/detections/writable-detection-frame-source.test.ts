import { describe, expect, it, vi } from "vitest";

import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import { DetectionFrameRetentionMode } from "#types/detection-timeline";
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

  it("applies rolling retention after appending frames", async () => {
    const frameStore: DetectionFrame[] = [];
    const store = createMutableStore(frameStore);
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      retention: {
        mode: DetectionFrameRetentionMode.PersistWindow,
        windowSeconds: 1,
      },
      store,
    });
    const earlyFrame: DetectionFrame = {
      detections: [{ id: "early" }],
      endTime: 0.25,
      frameIndex: 0,
      mediaTime: 0,
    };
    const retainedFrame: DetectionFrame = {
      detections: [{ id: "retained" }],
      endTime: 2.1,
      frameIndex: 60,
      mediaTime: 2,
    };

    await source.appendFrames([earlyFrame]);
    const retainedSummary = await source.appendFrames([retainedFrame]);

    expect(retainedSummary).toMatchObject({
      detectionCount: 1,
      endTime: 2.1,
      frameCount: 1,
      startTime: 2,
    });
    expect(await source.loadFrames(0, 3)).toEqual([retainedFrame]);
    expect(source.getAvailableRanges()).toEqual([
      { endTime: 2.1, startTime: 2 },
    ]);
  });

  it("keeps long-running rolling retention bounded over many appends", async () => {
    const frameStore: DetectionFrame[] = [];
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      retention: {
        mode: DetectionFrameRetentionMode.PersistWindow,
        windowSeconds: 2,
      },
      store: createMutableStore(frameStore),
    });
    const frameRate = 30;
    const longRunningFrames = Array.from({ length: 300 }, (_, index) => ({
      detections: [{ id: `frame-${index}` }],
      endTime: (index + 1) / frameRate,
      frameIndex: index,
      mediaTime: index / frameRate,
    }));

    for (let index = 0; index < longRunningFrames.length; index += 10) {
      await source.appendFrames(longRunningFrames.slice(index, index + 10));
    }

    expect(source.getSummary()).toMatchObject({
      detectionCount: 60,
      endTime: 10,
      frameCount: 60,
      startTime: 8,
    });
    expect(await source.loadFrames(0, 10)).toHaveLength(60);
    expect(source.getAvailableRanges()).toEqual([
      { endTime: 10, startTime: 8 },
    ]);
  });

  it("rejects late operations after destroy without writing to storage", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    source.destroy?.();

    await expect(source.appendFrames(frames)).rejects.toThrow(
      "Detection frame source has been destroyed.",
    );
    await expect(source.replaceFrames(frames)).rejects.toThrow(
      "Detection frame source has been destroyed.",
    );
    await expect(source.clear()).rejects.toThrow(
      "Detection frame source has been destroyed.",
    );
    await expect(source.loadFrames(0, 1)).rejects.toThrow(
      "Detection frame source has been destroyed.",
    );
    expect(store.appendFrames).not.toHaveBeenCalled();
    expect(store.putFrames).not.toHaveBeenCalled();
    expect(store.clearDataset).not.toHaveBeenCalled();
    expect(store.loadFrames).not.toHaveBeenCalled();
  });

  it("rejects an in-flight append that resolves after destroy", async () => {
    const append = createDeferred<ColdDetectionFrameStoreWriteSummary>();
    const store = createStore();
    store.appendFrames = vi.fn(() => append.promise);
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });
    const pendingAppend = source.appendFrames(frames);

    source.destroy?.();
    append.resolve(summary);

    await expect(pendingAppend).rejects.toThrow(
      "Detection frame source has been destroyed.",
    );
    expect(source.getSummary()).toBeNull();
    expect(source.getVersion()).toBe(0);
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

function createMutableStore(
  storedFrames: DetectionFrame[],
): ColdDetectionFrameStore {
  return {
    async appendFrames(options) {
      storedFrames.splice(
        0,
        storedFrames.length,
        ...dedupeFrames([...storedFrames, ...options.frames]),
      );

      return createSummary(options.datasetId, storedFrames);
    },
    async clearDataset() {
      storedFrames.length = 0;
    },
    async loadFrames(options) {
      return storedFrames.filter(
        (frame) =>
          frame.mediaTime <= options.endTime &&
          (frame.endTime ?? frame.mediaTime) > options.startTime,
      );
    },
    async putFrames(options) {
      storedFrames.splice(0, storedFrames.length, ...options.frames);

      return createSummary(options.datasetId, storedFrames);
    },
  };
}

function createSummary(
  datasetId: string,
  storedFrames: readonly DetectionFrame[],
): ColdDetectionFrameStoreWriteSummary {
  const firstFrame = storedFrames[0];
  const lastFrame = storedFrames.at(-1);

  return {
    chunkCount: storedFrames.length === 0 ? 0 : 1,
    chunkDurationSeconds: 1,
    datasetId,
    detectionCount: storedFrames.reduce(
      (total, frame) => total + frame.detections.length,
      0,
    ),
    endTime: lastFrame ? (lastFrame.endTime ?? lastFrame.mediaTime) : null,
    frameCount: storedFrames.length,
    startTime: firstFrame?.mediaTime ?? null,
  };
}

function dedupeFrames(frames: readonly DetectionFrame[]) {
  const deduped = new Map<string, DetectionFrame>();

  for (const frame of frames) {
    deduped.set(`${frame.frameIndex ?? "time"}:${frame.mediaTime}`, frame);
  }

  return Array.from(deduped.values()).sort(
    (left, right) => left.mediaTime - right.mediaTime,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}
