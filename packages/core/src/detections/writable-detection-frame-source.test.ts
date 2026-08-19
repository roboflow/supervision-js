import { describe, expect, it, vi } from "vitest";

import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
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

  it("reports and coalesces incremental changes after a source version", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await source.appendFrames([
      { detections: [], endTime: 1, frameIndex: 0, mediaTime: 0 },
    ]);
    await source.appendFrames([
      { detections: [], endTime: 2, frameIndex: 1, mediaTime: 1 },
    ]);
    await source.appendFrames([
      { detections: [], endTime: 11, frameIndex: 10, mediaTime: 10 },
    ]);

    expect(source.getChangesSince!(0, [{ endTime: 3, startTime: 0 }])).toEqual({
      ranges: [{ endTime: 2, startTime: 0 }],
      requiresReload: false,
      version: 2,
    });
    expect(source.getChangesSince!(2, [{ endTime: 3, startTime: 0 }])).toEqual({
      ranges: [],
      requiresReload: false,
      version: 2,
    });
  });

  it("requires a full reload after replacement and journal compaction", async () => {
    const store = createStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await source.replaceFrames(frames);

    expect(
      source.getChangesSince!(0, [{ endTime: 1, startTime: 0 }]),
    ).toMatchObject({ requiresReload: true, version: 1 });

    for (let frameIndex = 0; frameIndex < 513; frameIndex += 1) {
      await source.appendFrames([
        {
          detections: [],
          endTime: frameIndex + 2,
          frameIndex,
          mediaTime: frameIndex + 1,
        },
      ]);
    }

    expect(
      source.getChangesSince!(1, [{ endTime: 600, startTime: 0 }]),
    ).toMatchObject({ requiresReload: true, version: 514 });
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

  it("keeps sparse out-of-order batch ranges unavailable and separately journaled", async () => {
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
        endTime: 3,
        frameIndex: 2,
        mediaTime: 2,
      },
      {
        detections: [],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0,
      },
    ]);
    await Promise.resolve();

    expect.soft(resolved).toBe(false);
    expect(source.getVersion()).toBe(1);
    expect(source.getVersion({ endTime: 1.75, startTime: 1.25 })).toBe(0);
    expect(source.getAvailableRanges()).toEqual([
      { endTime: 1, startTime: 0 },
      { endTime: 3, startTime: 2 },
    ]);
    expect(source.getChangesSince!(0, [{ endTime: 3, startTime: 0 }])).toEqual({
      ranges: [
        { endTime: 1, startTime: 0 },
        { endTime: 3, startTime: 2 },
      ],
      requiresReload: false,
      version: 1,
    });

    await source.appendFrames([
      {
        detections: [],
        endTime: 2,
        frameIndex: 1,
        mediaTime: 1,
      },
    ]);
    await waitForRange;

    expect(resolved).toBe(true);
    expect(source.getAvailableRanges()).toEqual([{ endTime: 3, startTime: 0 }]);
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

  it("prunes retained history in place instead of rewriting the window", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      retention: {
        mode: DetectionFrameRetentionMode.PersistWindow,
        windowSeconds: 2,
      },
      store,
    });
    const frameRate = 30;

    for (let index = 0; index < 300; index += 10) {
      await source.appendFrames(
        Array.from({ length: 10 }, (_, offset) => {
          const frameIndex = index + offset;

          return {
            detections: [{ id: `frame-${frameIndex}` }],
            endTime: (frameIndex + 1) / frameRate,
            frameIndex,
            mediaTime: frameIndex / frameRate,
          };
        }),
      );
    }

    // Retention no longer reloads and republishes everything it keeps, and the
    // hot timeline can patch the appended and evicted ranges instead of
    // reloading its window.
    expect(store.calls.loadFrames).toBe(0);
    expect(store.calls.putFrames).toBe(0);
    expect(source.getSummary()).toMatchObject({
      endTime: 10,
      frameCount: 60,
      startTime: 8,
    });
    expect(source.getAvailableRanges()).toEqual([
      { endTime: 10, startTime: 8 },
    ]);
    expect(
      source.getChangesSince?.(0, [{ endTime: 10, startTime: 8 }])
        ?.requiresReload,
    ).toBe(false);
  });

  it("reports pruned history and the new append as separate bounded ranges", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      retention: {
        mode: DetectionFrameRetentionMode.PersistWindow,
        windowSeconds: 1,
      },
      store,
    });

    await source.appendFrames([
      {
        detections: [{ id: "old" }],
        endTime: 0.5,
        frameIndex: 0,
        mediaTime: 0,
      },
    ]);
    const settledVersion = source.getVersion();
    await source.appendFrames([
      { detections: [{ id: "new" }], endTime: 3, frameIndex: 1, mediaTime: 2 },
    ]);

    const changes = source.getChangesSince?.(settledVersion, [
      { endTime: 3, startTime: 0 },
    ]);

    // The evicted range and the appended range are reported together, so a hot
    // timeline patches only what actually moved instead of reloading.
    expect(changes?.requiresReload).toBe(false);
    expect(changes?.ranges).toEqual([{ endTime: 3, startTime: 0 }]);
    expect(source.getAvailableRanges()).toEqual([{ endTime: 3, startTime: 2 }]);
  });

  it("invalidates the coverage a closed open-ended frame gave up", async () => {
    const store = createMemoryColdDetectionFrameStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store,
    });

    await source.appendFrames([
      { detections: [{ id: "box" }], frameIndex: 0, mediaTime: 0 },
    ]);
    const openEndedVersion = source.getVersion();

    await source.appendFrames([
      {
        detections: [{ id: "box" }],
        endTime: 0.1,
        frameIndex: 0,
        mediaTime: 0,
      },
    ]);

    // The frame was selected everywhere past 0 while it was open-ended, so
    // closing it changes what a consumer parked at 0.5 should be showing. The
    // vacated interval has no upper bound to report, so it reloads instead.
    expect(await source.loadFrames(0.5, 0.5)).toEqual([]);
    expect(
      source.getChangesSince?.(openEndedVersion, [
        { endTime: 0.5, startTime: 0.5 },
      ]),
    ).toMatchObject({ requiresReload: true });
  });

  it("invalidates the interval a rewritten frame no longer covers", async () => {
    const store = createMemoryColdDetectionFrameStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store,
    });

    await source.appendFrames([
      { detections: [{ id: "box" }], endTime: 1, frameIndex: 0, mediaTime: 0 },
    ]);
    const previousVersion = source.getVersion();

    await source.appendFrames([
      { detections: [{ id: "box" }], endTime: 6, frameIndex: 0, mediaTime: 5 },
    ]);

    // Rewriting the frame at a later time replaces it rather than adding a
    // second one, so the interval it left behind is reported alongside the
    // interval it moved to.
    expect(await source.loadFrames(0.5, 0.5)).toEqual([]);
    expect(
      source.getChangesSince?.(previousVersion, [
        { endTime: 0.5, startTime: 0.5 },
      ]),
    ).toEqual({
      ranges: [{ endTime: 1, startTime: 0 }],
      requiresReload: false,
      version: 2,
    });
  });

  it("holds the newest live frame open until the next one supersedes it", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 30 },
      store,
    });

    await source.appendLiveFrame({
      detections: [{ id: "first" }],
      frameIndex: 0,
      mediaTime: 1,
    });

    expect(await source.loadFrames(0, 40)).toEqual([
      {
        detections: [{ id: "first" }],
        endTime: 31,
        frameIndex: 0,
        mediaTime: 1,
      },
    ]);

    await source.appendLiveFrame({
      detections: [{ id: "second" }],
      frameIndex: 1,
      mediaTime: 2,
    });

    // Two frames per live append, whatever the retained history looks like.
    expect(store.calls.appendedFrameCounts).toEqual([1, 2]);
    expect(await source.loadFrames(0, 40)).toEqual([
      {
        detections: [{ id: "first" }],
        endTime: 2,
        frameIndex: 0,
        mediaTime: 1,
      },
      {
        detections: [{ id: "second" }],
        endTime: 32,
        frameIndex: 1,
        mediaTime: 2,
      },
    ]);
  });

  it("drops an out-of-order live result instead of reopening closed coverage", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 30 },
      store,
    });

    await source.appendLiveFrame({
      detections: [{ id: "first" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    const appendCallCount = store.calls.appendedFrameCounts.length;
    const version = source.getVersion();

    await source.appendLiveFrame({
      detections: [{ id: "stale" }],
      frameIndex: 1,
      mediaTime: 1.5,
    });

    expect(store.calls.appendedFrameCounts).toHaveLength(appendCallCount);
    expect(source.getVersion()).toBe(version);
    expect(await source.loadFrames(0, 40)).toEqual([
      {
        detections: [{ id: "first" }],
        endTime: 32,
        frameIndex: 0,
        mediaTime: 2,
      },
    ]);
  });

  it("revises the held live frame when the newest result repeats its identity", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 30 },
      store: createInstrumentedMemoryStore(),
    });

    await source.appendLiveFrame({
      detections: [{ id: "first" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    await source.appendLiveFrame({
      detections: [{ id: "revised" }],
      frameIndex: 0,
      mediaTime: 2,
    });

    expect(await source.loadFrames(0, 40)).toEqual([
      {
        detections: [{ id: "revised" }],
        endTime: 32,
        frameIndex: 0,
        mediaTime: 2,
      },
    ]);
  });

  it("serializes concurrent live appends so only the newest stays open", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 10 },
      store: createInstrumentedMemoryStore(),
    });

    await Promise.all([
      source.appendLiveFrame({
        detections: [{ id: "first" }],
        frameIndex: 0,
        mediaTime: 1,
      }),
      source.appendLiveFrame({
        detections: [{ id: "second" }],
        frameIndex: 1,
        mediaTime: 2,
      }),
    ]);

    expect(await source.loadFrames(0, 40)).toEqual([
      {
        detections: [{ id: "first" }],
        endTime: 2,
        frameIndex: 0,
        mediaTime: 1,
      },
      {
        detections: [{ id: "second" }],
        endTime: 12,
        frameIndex: 1,
        mediaTime: 2,
      },
    ]);
  });

  it("places the retention window on real coverage, not on the live hold", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 60 },
      retention: {
        mode: DetectionFrameRetentionMode.MemoryOnly,
        windowSeconds: 2,
      },
      store: createInstrumentedMemoryStore(),
    });

    await source.appendLiveFrame({
      detections: [{ id: "only" }],
      frameIndex: 0,
      mediaTime: 1,
    });

    expect(source.getAvailableRanges()).toEqual([
      { endTime: 61, startTime: 1 },
    ]);
    expect(await source.loadFrames(0, 61)).toHaveLength(1);
  });

  it("closes a held live frame at a shorter known end of media", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 60 },
      store: createInstrumentedMemoryStore(),
    });

    await source.appendLiveFrame({
      detections: [{ id: "last" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    await source.finalizeCoverage(3);

    expect(await source.loadFrames(0, 61)).toEqual([
      {
        detections: [{ id: "last" }],
        endTime: 3,
        frameIndex: 0,
        mediaTime: 2,
      },
    ]);
    expect(source.getAvailableRanges()).toEqual([{ endTime: 3, startTime: 2 }]);
  });

  it("finalizes the revision when a live frame was revised in place", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 60 },
      store: createInstrumentedMemoryStore(),
    });

    await source.appendLiveFrame({
      detections: [{ id: "original" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    await source.appendLiveFrame({
      detections: [{ id: "revised" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    await source.finalizeCoverage(3);

    expect(await source.loadFrames(0, 61)).toEqual([
      {
        detections: [{ id: "revised" }],
        endTime: 3,
        frameIndex: 0,
        mediaTime: 2,
      },
    ]);
  });

  it("finalizes the revision when an appended frame was revised in place", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store: createInstrumentedMemoryStore(),
    });

    await source.appendFrames([
      {
        detections: [{ id: "original" }],
        endTime: 8.9,
        frameIndex: 88,
        mediaTime: 8.8,
      },
    ]);
    await source.appendFrames([
      {
        detections: [{ id: "revised" }],
        endTime: 8.9,
        frameIndex: 88,
        mediaTime: 8.8,
      },
    ]);
    await source.finalizeCoverage(9);

    expect(await source.loadFrames(8, 9)).toEqual([
      {
        detections: [{ id: "revised" }],
        endTime: 9,
        frameIndex: 88,
        mediaTime: 8.8,
      },
    ]);
  });

  it("finalizes a shortened coverage end only once", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "live",
      live: { holdSeconds: 60 },
      store,
    });

    await source.appendLiveFrame({
      detections: [{ id: "last" }],
      frameIndex: 0,
      mediaTime: 2,
    });
    await source.finalizeCoverage(3);
    const appendCallCount = store.calls.appendedFrameCounts.length;
    const version = source.getVersion();

    await source.finalizeCoverage(3);

    expect(store.calls.appendedFrameCounts).toHaveLength(appendCallCount);
    expect(source.getVersion()).toBe(version);
  });

  it("finalizes the last frame's coverage once at a known end of media", async () => {
    const store = createInstrumentedMemoryStore();
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store,
    });

    await source.appendFrames([
      {
        detections: [{ id: "last" }],
        endTime: 8.9,
        frameIndex: 88,
        mediaTime: 8.8,
      },
    ]);
    const finalized = await source.finalizeCoverage(9);

    expect(finalized).toMatchObject({ endTime: 9, frameCount: 1 });
    expect(await source.loadFrames(8, 9)).toEqual([
      {
        detections: [{ id: "last" }],
        endTime: 9,
        frameIndex: 88,
        mediaTime: 8.8,
      },
    ]);

    const appendCallCount = store.calls.appendedFrameCounts.length;
    const version = source.getVersion();

    await expect(source.finalizeCoverage(9)).resolves.toMatchObject({
      endTime: 9,
    });

    expect(store.calls.appendedFrameCounts).toHaveLength(appendCallCount);
    expect(source.getVersion()).toBe(version);
  });

  it("reports no finalization work when nothing has been appended", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "dataset",
      store: createInstrumentedMemoryStore(),
    });

    await expect(source.finalizeCoverage(9)).resolves.toBeNull();
    await expect(source.finalizeCoverage(Number.NaN)).rejects.toThrow(
      "finalizeCoverage requires a finite endTime.",
    );
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

function createInstrumentedMemoryStore() {
  const store = createMemoryColdDetectionFrameStore();
  const calls = {
    appendedFrameCounts: [] as number[],
    loadFrames: 0,
    putFrames: 0,
  };

  return {
    ...store,
    calls,
    appendFrames(options) {
      calls.appendedFrameCounts.push(options.frames.length);

      return store.appendFrames(options);
    },
    loadFrames(options) {
      calls.loadFrames += 1;

      return store.loadFrames(options);
    },
    putFrames(options) {
      calls.putFrames += 1;

      return store.putFrames(options);
    },
  } satisfies ColdDetectionFrameStore & { readonly calls: typeof calls };
}

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
