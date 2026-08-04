import { describe, expect, it, vi } from "vitest";

import { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
import {
  createBufferedDetectionTimeline,
  getBufferedDetectionTimelineFrameSnapshot,
} from "#detections/buffered-detection-timeline";
import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import {
  DetectionBufferStatus,
  DetectionFrameSelectionMode,
} from "#types/detection-timeline";
import { DetectionMaskEncoding, type DetectionFrame } from "#types/detections";

const frames: DetectionFrame[] = [
  {
    detections: [{ rect: { height: 10, width: 10, x: 0, y: 0 } }],
    mediaTime: 0,
  },
  {
    detections: [
      { rect: { height: 20, width: 20, x: 1, y: 1 } },
      { rect: { height: 30, width: 30, x: 2, y: 2 } },
    ],
    mediaTime: 1,
  },
  {
    detections: [{ rect: { height: 40, width: 40, x: 3, y: 3 } }],
    mediaTime: 4,
  },
];

describe("buffered detection timeline", () => {
  it("loads a warm window and selects frames synchronously from the hot buffer", async () => {
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0.5,
      source: createArrayDetectionFrameSource(frames),
    });

    await timeline.prepare(1.25);

    expect(timeline.getState()).toEqual({
      bufferEndTime: 3.25,
      bufferStartTime: 0.75,
      detectionCount: 2,
      errorMessage: null,
      frameCount: 1,
      requestedEndTime: 3.25,
      requestedStartTime: 0.75,
      status: DetectionBufferStatus.Ready,
    });
    expect(timeline.selectFrame(1.25)?.mediaTime).toBe(1);
    expect(timeline.selectFrame(0.5)).toBeUndefined();
  });

  it("exposes copied buffered frames for background preparation", async () => {
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source: createArrayDetectionFrameSource(frames),
    });

    await timeline.prepare(0);

    const bufferedFrames = timeline.getBufferedFrames();

    expect(bufferedFrames.map((frame) => frame.mediaTime)).toEqual([0, 1]);
    expect(bufferedFrames[0]).not.toBe(frames[0]);
    expect(bufferedFrames[0]?.detections[0]?.rect).not.toBe(
      frames[0]?.detections[0]?.rect,
    );
  });

  it("reuses its internal rich-geometry snapshot until the hot buffer changes", async () => {
    let version = 0;
    const richFrames: DetectionFrame[] = [
      {
        detections: [
          {
            id: "pose",
            keypoints: {
              edges: [[0, 1]],
              points: [
                { x: 10, y: 20 },
                { x: 30, y: 40 },
              ],
              visibility: [2, 2],
            },
            polygon: {
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
              ],
            },
          },
        ],
        mediaTime: 0,
      },
    ];
    const source = {
      getVersion: vi.fn(() => version),
      loadFrames: vi.fn(async () => richFrames),
    };
    const timeline = createBufferedDetectionTimeline({ source });

    await timeline.prepare(0);

    const firstSnapshot = getBufferedDetectionTimelineFrameSnapshot(timeline);
    const secondSnapshot = getBufferedDetectionTimelineFrameSnapshot(timeline);
    const publicCopy = timeline.getBufferedFrames();

    expect(secondSnapshot).toBe(firstSnapshot);
    expect(secondSnapshot[0]?.detections[0]?.polygon?.points).toBe(
      firstSnapshot[0]?.detections[0]?.polygon?.points,
    );
    expect(publicCopy).not.toBe(firstSnapshot);
    expect(publicCopy[0]).not.toBe(firstSnapshot[0]);
    expect(publicCopy[0]?.detections[0]?.keypoints?.points).not.toBe(
      firstSnapshot[0]?.detections[0]?.keypoints?.points,
    );

    version += 1;
    await timeline.prepare(0);

    expect(getBufferedDetectionTimelineFrameSnapshot(timeline)).not.toBe(
      firstSnapshot,
    );
    expect(source.loadFrames).toHaveBeenCalledTimes(2);
  });

  it("passes frame-indexed selection options to hot-buffer frame lookup", async () => {
    const indexedFrames: DetectionFrame[] = [
      {
        detections: [],
        endTime: 52 / 30,
        frameIndex: 51,
        mediaTime: 51 / 30,
      },
      {
        detections: [],
        endTime: 53 / 30,
        frameIndex: 52,
        mediaTime: 52 / 30,
      },
    ];
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 1,
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      source: createArrayDetectionFrameSource(indexedFrames),
    });

    await timeline.prepare(1.73);

    expect(timeline.selectFrame(1.73)?.frameIndex).toBe(52);
  });

  it("selects nearest 30fps frame indexes from the hot buffer", async () => {
    const indexedFrames: DetectionFrame[] = Array.from(
      { length: 4 },
      (_, index) => ({
        detections: [{ id: `frame-${index}` }],
        endTime: (index + 1) / 30,
        frameIndex: index,
        mediaTime: index / 30,
      }),
    );
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 0,
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      source: createArrayDetectionFrameSource(indexedFrames),
    });

    await timeline.prepare(0);

    expect(timeline.selectFrame(0.49 / 30)?.frameIndex).toBe(0);
    expect(timeline.selectFrame(0.5 / 30)?.frameIndex).toBe(1);
    expect(timeline.selectFrame(2.49 / 30)?.frameIndex).toBe(2);
    expect(timeline.selectFrame(2.5 / 30)?.frameIndex).toBe(3);
  });

  it("uses a one-frame indexed gap but does not synthesize larger missing gaps", async () => {
    const indexedFrames: DetectionFrame[] = [
      {
        detections: [{ id: "frame-10" }],
        endTime: 11 / 30,
        frameIndex: 10,
        mediaTime: 10 / 30,
      },
      {
        detections: [{ id: "frame-12" }],
        endTime: 13 / 30,
        frameIndex: 12,
        mediaTime: 12 / 30,
      },
      {
        detections: [{ id: "frame-20" }],
        endTime: 21 / 30,
        frameIndex: 20,
        mediaTime: 20 / 30,
      },
    ];
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 1,
      frameRate: 30,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      source: createArrayDetectionFrameSource(indexedFrames),
    });

    await timeline.prepare(11 / 30);

    expect(timeline.selectFrame(11 / 30)?.frameIndex).toBe(12);
    expect(timeline.selectFrame(16 / 30)).toBeUndefined();
  });

  it("keeps the last good buffer and reports prefetch errors", async () => {
    const source = {
      loadFrames: vi
        .fn()
        .mockResolvedValueOnce([frames[1]])
        .mockRejectedValueOnce(new Error("range unavailable")),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 0,
      source,
    });

    await timeline.prepare(1);
    timeline.prefetch(4);

    await vi.waitFor(() => {
      expect(timeline.getState().status).toBe(DetectionBufferStatus.Error);
    });

    expect(timeline.selectFrame(1.5)?.mediaTime).toBe(1);
    expect(timeline.getState()).toMatchObject({
      errorMessage: "range unavailable",
      frameCount: 1,
      status: DetectionBufferStatus.Error,
    });
  });

  it("reuses an in-flight load when it covers the requested range", async () => {
    const load = createDeferred<DetectionFrame[]>();
    const source = {
      loadFrames: vi.fn(() => load.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 1,
      source,
    });

    const initialLoad = timeline.prepare(1);
    timeline.prefetch(0.5);

    expect(source.loadFrames).toHaveBeenCalledOnce();
    expect(source.loadFrames).toHaveBeenCalledWith(0, 6);

    load.resolve([frames[0]]);
    await initialLoad;
  });

  it("can refresh the hot buffer continuously before it reaches the end", async () => {
    const source = {
      loadFrames: vi.fn(async () => frames),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0.5,
      refreshIntervalSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    timeline.prefetch(0.5);

    await vi.waitFor(() => {
      expect(source.loadFrames).toHaveBeenCalledTimes(2);
    });
    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 0, 5);
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 0, 5.5);
  });

  it("hydrates loop-crossing hot buffers from tail and head source ranges", async () => {
    const loopFrames: DetectionFrame[] = [
      {
        detections: [{ rect: { height: 10, width: 10, x: 0, y: 0 } }],
        mediaTime: 0,
      },
      {
        detections: [{ rect: { height: 20, width: 20, x: 1, y: 1 } }],
        mediaTime: 1,
      },
      {
        detections: [{ rect: { height: 30, width: 30, x: 2, y: 2 } }],
        mediaTime: 4.6,
      },
    ];
    const source = {
      loadFrames: vi.fn(async (startTime: number, endTime: number) =>
        loopFrames.filter(
          (frame) => frame.mediaTime >= startTime && frame.mediaTime <= endTime,
        ),
      ),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0.5,
      source,
    });

    (
      timeline as unknown as {
        setTimelineContext(context: {
          readonly duration: number;
          readonly loop: boolean;
        }): void;
      }
    ).setTimelineContext({ duration: 5, loop: true });

    await timeline.prepare(4.75);

    expect(source.loadFrames).toHaveBeenCalledTimes(2);
    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 4.25, 5);
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 0, 1.75);
    expect(
      timeline.getBufferedFrames().map((frame) => frame.mediaTime),
    ).toEqual([0, 1, 4.6]);
    expect(timeline.selectFrame(4.75)?.mediaTime).toBe(4.6);
    expect(timeline.selectFrame(0.5)?.mediaTime).toBe(0);
  });

  it("waits for source coverage before loading when playback gating is enabled", async () => {
    const coverage = createDeferred<void>();
    const source = {
      loadFrames: vi.fn(async () => [frames[0]]),
      waitForRange: vi.fn(() => coverage.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 0,
      playbackGate: {
        enabled: true,
        requiredAheadSeconds: 2,
      },
      source,
    });
    const prepare = timeline.prepare(1, { gatePlayback: true });

    await Promise.resolve();

    expect(source.waitForRange).toHaveBeenCalledWith({
      endTime: 3,
      startTime: 1,
    });
    expect(source.loadFrames).not.toHaveBeenCalled();
    expect(timeline.getState()).toMatchObject({
      requestedEndTime: 3,
      requestedStartTime: 1,
      status: DetectionBufferStatus.Loading,
    });

    coverage.resolve();
    await prepare;

    expect(source.loadFrames).toHaveBeenCalledWith(1, 2);
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
  });

  it("waits for loop-crossing source coverage when playback gating is enabled", async () => {
    const source = {
      loadFrames: vi.fn(async () => []),
      waitForRange: vi.fn(async () => undefined),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      playbackGate: {
        enabled: true,
        requiredAheadSeconds: 2,
      },
      source,
    });

    timeline.setTimelineContext?.({ duration: 5, loop: true });
    await timeline.prepare(4.75, {
      duration: 5,
      firstTimestamp: 0,
      gatePlayback: true,
    });

    expect(source.waitForRange).toHaveBeenCalledTimes(2);
    expect(source.waitForRange).toHaveBeenNthCalledWith(1, {
      endTime: 5,
      startTime: 4.75,
    });
    expect(source.waitForRange).toHaveBeenNthCalledWith(2, {
      endTime: 1.75,
      startTime: 0,
    });
  });

  it("does not start redundant prefetch loads covered by an in-flight range", async () => {
    const firstLoad = createDeferred<DetectionFrame[]>();
    const secondLoad = createDeferred<DetectionFrame[]>();
    const pendingLoads = [firstLoad, secondLoad];
    let loadIndex = 0;
    const source = {
      loadFrames: vi.fn(
        () => pendingLoads[loadIndex++]?.promise ?? Promise.resolve([]),
      ),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0,
      source,
    });

    const initialLoad = timeline.prepare(0);
    timeline.prefetch(4);

    expect(source.loadFrames).toHaveBeenCalledOnce();
    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 0, 5);

    firstLoad.resolve([frames[0]]);
    await initialLoad;
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
    secondLoad.resolve([frames[2]]);
  });

  it("destroys its source and prevents further loads", async () => {
    const source = {
      destroy: vi.fn(),
      loadFrames: vi.fn(async () => [frames[0]]),
    };
    const timeline = createBufferedDetectionTimeline({ source });

    timeline.destroy();
    await timeline.prepare(0);

    expect(source.destroy).toHaveBeenCalledOnce();
    expect(source.loadFrames).not.toHaveBeenCalled();
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Destroyed);
  });

  it("reloads a buffered range when the source version changes", async () => {
    let version = 0;
    const source = {
      getVersion: vi.fn(() => version),
      loadFrames: vi
        .fn()
        .mockResolvedValueOnce([frames[0]])
        .mockResolvedValueOnce([frames[1]]),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source,
    });

    await timeline.prepare(0);
    version += 1;
    await timeline.prepare(0.5);

    expect(source.loadFrames).toHaveBeenCalledTimes(2);
    expect(timeline.selectFrame(1)?.mediaTime).toBe(1);
  });

  it("keeps the current hot buffer when source changes do not overlap it", async () => {
    let globalVersion = 0;
    const currentRangeVersion = 0;
    const source = {
      getVersion: vi.fn((range?: { startTime: number; endTime: number }) =>
        range && range.endTime <= 2 ? currentRangeVersion : globalVersion,
      ),
      loadFrames: vi.fn().mockResolvedValue([frames[0]]),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source,
    });

    await timeline.prepare(0);
    globalVersion += 1;
    await timeline.prepare(0.5);

    expect(source.loadFrames).toHaveBeenCalledOnce();
    expect(timeline.selectFrame(0.5)?.mediaTime).toBe(0);
  });

  it("keeps the current hot buffer when appended detections are outside the buffered range", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store: createMemoryColdDetectionFrameStore(),
    });
    const loadFrames = vi.spyOn(source, "loadFrames");
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source,
    });

    await source.appendFrames([
      { detections: [{ id: "current" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0);
    await source.appendFrames([
      { detections: [{ id: "future" }], endTime: 11, mediaTime: 10 },
    ]);
    await timeline.prepare(0.5);

    expect(loadFrames).toHaveBeenCalledOnce();
    expect(timeline.selectFrame(0.5)?.detections[0]?.id).toBe("current");
  });

  it("reloads the current hot buffer when appended detections overlap the buffered range", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store: createMemoryColdDetectionFrameStore(),
    });
    const loadFrames = vi.spyOn(source, "loadFrames");
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source,
    });

    await source.appendFrames([
      { detections: [{ id: "initial" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0);
    await source.appendFrames([
      { detections: [{ id: "replacement" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0.5);

    expect(loadFrames).toHaveBeenCalledTimes(2);
    expect(loadFrames).toHaveBeenNthCalledWith(2, 0, 1);
    expect(timeline.selectFrame(0.5)?.detections[0]?.id).toBe("replacement");
  });

  it("patches progressive appends without repeatedly loading the growing hot window", async () => {
    const writableSource = createWritableDetectionFrameSource({
      datasetId: "progressive",
      store: createMemoryColdDetectionFrameStore(),
    });
    let loadedFrameRecords = 0;
    const source = {
      ...writableSource,
      async loadFrames(startTime: number, endTime: number) {
        const loadedFrames = await writableSource.loadFrames(
          startTime,
          endTime,
        );

        loadedFrameRecords += loadedFrames.length;
        return loadedFrames;
      },
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0,
      source,
    });

    for (let frameIndex = 0; frameIndex < 150; frameIndex += 1) {
      await writableSource.appendFrames([
        {
          detections: [
            {
              id: `mask-${frameIndex}`,
              mask: {
                counts: "1234567890".repeat(100),
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 10,
                width: 10,
              },
            },
          ],
          endTime: (frameIndex + 1) / 30,
          frameIndex,
          mediaTime: frameIndex / 30,
        },
      ]);
      await timeline.prepare(0);
    }

    expect(timeline.getState()).toMatchObject({
      detectionCount: 150,
      frameCount: 150,
    });
    expect(loadedFrameRecords).toBeLessThanOrEqual(300);
    expect(timeline.selectFrame(149 / 30)?.frameIndex).toBe(149);
  });

  it("falls back to a full hot-window reload after replacement", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "replace",
      store: createMemoryColdDetectionFrameStore(),
    });
    const loadFrames = vi.spyOn(source, "loadFrames");
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0,
      source,
    });

    await source.appendFrames([
      { detections: [{ id: "old" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0);
    await source.replaceFrames([
      { detections: [{ id: "new" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0);

    expect(loadFrames).toHaveBeenNthCalledWith(2, 0, 5);
    expect(timeline.selectFrame(0.5)?.detections[0]?.id).toBe("new");
  });

  it("does not let a delayed incremental patch overwrite a newer rolling window", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "concurrent-refresh",
      store: createMemoryColdDetectionFrameStore(),
    });
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0,
      refreshIntervalSeconds: 0.5,
      source,
    });

    await source.appendFrames([
      { detections: [{ id: "old" }], endTime: 1, mediaTime: 0 },
    ]);
    await timeline.prepare(0);

    const originalLoadFrames = source.loadFrames.bind(source);
    const delayedIncrementalFrames =
      createDeferred<readonly DetectionFrame[]>();
    const loadFrames = vi
      .spyOn(source, "loadFrames")
      .mockImplementationOnce(() => delayedIncrementalFrames.promise)
      .mockImplementation(originalLoadFrames);

    await source.appendFrames([
      { detections: [{ id: "new" }], endTime: 1, mediaTime: 0 },
    ]);
    const incrementalRefresh = timeline.prepare(0);

    await vi.waitFor(() => expect(loadFrames).toHaveBeenCalledOnce());
    timeline.prefetch(0.5);
    await vi.waitFor(() => expect(loadFrames).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timeline.getState().bufferEndTime).toBe(5.5));

    delayedIncrementalFrames.resolve([
      { detections: [{ id: "stale" }], endTime: 1, mediaTime: 0 },
    ]);
    await incrementalRefresh;

    expect(loadFrames).toHaveBeenCalledTimes(3);
    expect(timeline.selectFrame(0.5)?.detections[0]?.id).toBe("new");
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}
