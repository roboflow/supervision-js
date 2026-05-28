import { describe, expect, it, vi } from "vitest";

import { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
import { createBufferedDetectionTimeline } from "#detections/buffered-detection-timeline";
import { DetectionBufferStatus } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

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

  it("starts a new load when an in-flight range overlaps without covering the request", async () => {
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

    expect(source.loadFrames).toHaveBeenCalledTimes(2);
    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 0, 5);
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 4, 9);

    firstLoad.resolve([frames[0]]);
    secondLoad.resolve([frames[2]]);
    await initialLoad;
    await vi.waitFor(() => {
      expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
    });
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
