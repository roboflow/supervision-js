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
  DetectionFrameRetentionMode,
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

    const revisedSnapshot = getBufferedDetectionTimelineFrameSnapshot(timeline);

    expect(revisedSnapshot).not.toBe(firstSnapshot);
    expect(revisedSnapshot[0]).not.toBe(firstSnapshot[0]);
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

  /**
   * Recorded on the demo: a seek opened eleven chunk requests carrying between
   * 5.2 and 12.4 MB, all of them before the frame it landed on could be drawn,
   * on the same link the video was being read over. Six of sixteen seeks then
   * took over a second to show a picture, the worst 3215ms.
   */
  it("fetches the frame a jump lands on before the lead behind it", async () => {
    const source = {
      loadFrames: vi.fn(async () => frames),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      refreshIntervalSeconds: 2.5,
      source,
    });

    await timeline.prepare(0);
    source.loadFrames.mockClear();
    timeline.prefetch(40);

    await vi.waitFor(() => expect(timeline.getState().bufferEndTime).toBe(50));

    expect(source.loadFrames.mock.calls).toStrictEqual([
      [39.5, 40],
      [39.5, 50],
    ]);
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

  it("coalesces rolling prefetch while allowing the active load to commit", async () => {
    const firstRefresh = createDeferred<DetectionFrame[]>();
    const latestRefresh = createDeferred<DetectionFrame[]>();
    const source = {
      loadFrames: vi
        .fn()
        .mockResolvedValueOnce(frames)
        .mockImplementationOnce(() => firstRefresh.promise)
        .mockImplementationOnce(() => latestRefresh.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0.5,
      refreshIntervalSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    timeline.prefetch(0.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));

    for (let frameIndex = 18; frameIndex <= 36; frameIndex += 1) {
      timeline.prefetch(frameIndex / 30);
    }

    expect(source.loadFrames).toHaveBeenCalledTimes(2);

    firstRefresh.resolve(frames);
    await vi.waitFor(() => expect(timeline.getState().bufferEndTime).toBe(5.5));
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(3));
    expect(source.loadFrames).toHaveBeenLastCalledWith(0.7, 6.2);

    latestRefresh.resolve(frames);
    await vi.waitFor(() => expect(timeline.getState().bufferEndTime).toBe(6.2));
    expect(source.loadFrames).toHaveBeenCalledTimes(3);
  });

  it("drops queued rolling work after a newer navigation load starts", async () => {
    const rollingRefresh = createDeferred<DetectionFrame[]>();
    const navigationLoad = createDeferred<DetectionFrame[]>();
    const source = {
      loadFrames: vi
        .fn()
        .mockResolvedValueOnce(frames)
        .mockImplementationOnce(() => rollingRefresh.promise)
        .mockImplementationOnce(() => navigationLoad.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0.5,
      refreshIntervalSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    timeline.prefetch(0.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));
    timeline.prefetch(1.2);

    const navigation = timeline.prepare(10);

    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(3));
    expect(source.loadFrames).toHaveBeenLastCalledWith(9.5, 15);

    navigationLoad.resolve(frames);
    await navigation;
    rollingRefresh.resolve(frames);
    await Promise.resolve();
    await Promise.resolve();

    expect(timeline.getState().bufferStartTime).toBe(9.5);
    expect(timeline.getState().bufferEndTime).toBe(15);
    expect(source.loadFrames).toHaveBeenCalledTimes(3);
  });

  it("retains unchanged internal frames across an immutable rolling window", async () => {
    const source = { loadFrames: vi.fn(async () => frames) };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 5,
      bufferBehindSeconds: 0.5,
      refreshIntervalSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    const initialSnapshot = getBufferedDetectionTimelineFrameSnapshot(timeline);
    const initialPublicFrame = timeline.getBufferedFrames()[0];

    timeline.prefetch(0.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timeline.getState().bufferEndTime).toBe(5.5));
    const refreshedSnapshot =
      getBufferedDetectionTimelineFrameSnapshot(timeline);

    expect(refreshedSnapshot).not.toBe(initialSnapshot);
    expect(refreshedSnapshot[0]).toBe(initialSnapshot[0]);
    expect(timeline.getBufferedFrames()[0]).not.toBe(initialPublicFrame);
    expect(timeline.getBufferedFrames()[0]).not.toBe(refreshedSnapshot[0]);
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
      status: DetectionBufferStatus.AwaitingCoverage,
    });

    coverage.resolve();
    await prepare;

    expect(source.loadFrames).toHaveBeenCalledWith(1, 2);
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
  });

  it("loads without waiting for source coverage when no gate is configured", async () => {
    const coverage = createDeferred<void>();
    const source = {
      loadFrames: vi.fn(async () => [frames[0]]),
      waitForRange: vi.fn(() => coverage.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 0,
      source,
    });

    await timeline.prepare(1, { gatePlayback: true });

    expect(source.waitForRange).not.toHaveBeenCalled();
    expect(source.loadFrames).toHaveBeenCalledWith(1, 2);
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);

    coverage.resolve();
  });

  it("loads without waiting for source coverage when the gate is disabled", async () => {
    const coverage = createDeferred<void>();
    const source = {
      loadFrames: vi.fn(async () => [frames[0]]),
      waitForRange: vi.fn(() => coverage.promise),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 0,
      playbackGate: {
        enabled: false,
        requiredAheadSeconds: 2,
      },
      source,
    });

    await timeline.prepare(1, { gatePlayback: true });

    expect(source.waitForRange).not.toHaveBeenCalled();
    expect(source.loadFrames).toHaveBeenCalledWith(1, 2);
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);

    coverage.resolve();
  });

  it("holds playback until an appendable source covers the frame under the playhead", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store: createMemoryColdDetectionFrameStore(),
    });

    await source.appendFrames([
      { detections: [{ id: "opening" }], endTime: 1, mediaTime: 0 },
    ]);

    const loadFrames = vi.spyOn(source, "loadFrames");
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      playbackGate: { enabled: true },
      source,
    });
    const prepare = timeline.prepare(2, { gatePlayback: true });

    await Promise.resolve();

    expect(loadFrames).not.toHaveBeenCalled();
    expect(timeline.getState()).toMatchObject({
      requestedEndTime: 2,
      requestedStartTime: 2,
      status: DetectionBufferStatus.AwaitingCoverage,
    });

    await source.appendFrames([
      { detections: [{ id: "playhead" }], endTime: 3, mediaTime: 2 },
    ]);
    await prepare;

    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
    expect(timeline.selectFrame(2)?.detections[0]?.id).toBe("playhead");
  });

  it("reports awaiting coverage while it waits and loading once it fetches", async () => {
    const coverage = createDeferred<void>();
    const load = createDeferred<DetectionFrame[]>();
    const source = {
      loadFrames: vi.fn(() => load.promise),
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

    expect(timeline.getState().status).toBe(
      DetectionBufferStatus.AwaitingCoverage,
    );

    coverage.resolve();
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalled());

    expect(timeline.getState().status).toBe(DetectionBufferStatus.Loading);

    load.resolve([frames[1]]);
    await prepare;

    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
  });

  it("gives up on coverage the source never produces", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store: createMemoryColdDetectionFrameStore(),
    });

    await source.appendFrames([
      { detections: [{ id: "opening" }], endTime: 1, mediaTime: 0 },
    ]);

    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      playbackGate: {
        enabled: true,
        maxWaitSeconds: 0.01,
        requiredAheadSeconds: 2,
      },
      source,
    });

    await timeline.prepare(2, { gatePlayback: true });

    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);
  });

  it("waits again only once an abandoned source has gained data", async () => {
    const source = createWritableDetectionFrameSource({
      datasetId: "stream",
      store: createMemoryColdDetectionFrameStore(),
    });

    await source.appendFrames([
      { detections: [{ id: "opening" }], endTime: 1, mediaTime: 0 },
    ]);

    const waitForRange = vi.spyOn(source, "waitForRange");
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      playbackGate: { enabled: true, maxWaitSeconds: 0.01 },
      source,
    });

    await timeline.prepare(2, { gatePlayback: true });
    await timeline.prepare(2.5, { gatePlayback: true });

    expect(waitForRange).toHaveBeenCalledTimes(1);

    await source.appendFrames([
      { detections: [{ id: "late" }], endTime: 4, mediaTime: 3 },
    ]);
    await timeline.prepare(3, { gatePlayback: true });

    expect(waitForRange).toHaveBeenCalledTimes(2);
    expect(timeline.selectFrame(3)?.detections[0]?.id).toBe("late");
  });

  it("loads without waiting for source coverage when the caller does not gate", async () => {
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

    await timeline.prepare(1);

    expect(source.waitForRange).not.toHaveBeenCalled();
    expect(source.loadFrames).toHaveBeenCalledWith(1, 2);
    expect(timeline.getState().status).toBe(DetectionBufferStatus.Ready);

    coverage.resolve();
  });

  it("loads forward when playback advances past the buffered window on a looping timeline", async () => {
    const loadFrames = vi.fn(async () => []);
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0.5,
      source: { loadFrames },
    });

    timeline.setTimelineContext?.({ duration: 60, loop: true });
    await timeline.prepare(0, { duration: 60, firstTimestamp: 0 });
    // One step past the buffered window is ordinary forward playback; mapping
    // it a whole loop down would drag every later request negative for good.
    await timeline.prepare(2.5, { duration: 60, firstTimestamp: 0 });

    const state = timeline.getState();
    expect(state.requestedStartTime).toBe(2);
    expect(state.requestedEndTime).toBe(4.5);
  });

  it("keeps a far paused jump selectable after several loop laps", async () => {
    const loadFrames = vi.fn(async (startTime: number, endTime: number) => {
      const loaded: DetectionFrame[] = [];
      for (
        let mediaTime = Math.max(0, Math.ceil(startTime * 2) / 2);
        mediaTime <= Math.min(60, endTime);
        mediaTime += 0.5
      ) {
        loaded.push({ detections: [], mediaTime });
      }
      return loaded;
    });
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 7,
      bufferBehindSeconds: 3.5,
      source: { loadFrames },
    });

    timeline.setTimelineContext?.({ duration: 60, loop: true });

    // A wrapped consumer clock walking through two full laps: the playhead
    // hands the timeline only times inside [0, 60].
    for (const playhead of [30, 45, 58, 2, 20, 40, 57, 3, 25, 39]) {
      await timeline.prepare(playhead, { duration: 60, firstTimestamp: 0 });
    }

    expect(timeline.selectFrame(39)?.mediaTime).toBe(39);

    // The paused far jump: one prepare, then no further playhead traffic.
    await timeline.prepare(17.25, { duration: 60, firstTimestamp: 0 });

    expect(timeline.selectFrame(17.25)?.mediaTime).toBe(17);
    expect(timeline.selectFrame(17.5)?.mediaTime).toBe(17.5);
  });

  it("states the buffered window on the media clock after many laps", async () => {
    const timeline = createLoopingTimeline();

    timeline.setTimelineContext?.({ duration: 60, loop: true });

    for (const playhead of [30, 50, 5, 45, 10, 55, 20, 40, 3, 35]) {
      await timeline.prepare(playhead, { duration: 60, firstTimestamp: 0 });

      const state = timeline.getState();

      expect(state.bufferStartTime).toBe(playhead - 0.5);
      expect(state.bufferEndTime).toBe(playhead + 7);
      // What every host does with the window: hold it against the playhead.
      expect(state.bufferStartTime).toBeLessThanOrEqual(playhead);
      expect(state.bufferEndTime).toBeGreaterThanOrEqual(playhead);
    }
  });

  it("states a window that ran past the loop point on the lap the playhead is on", async () => {
    const timeline = createLoopingTimeline();

    timeline.setTimelineContext?.({ duration: 60, loop: true });

    // Playback into the last seconds plans a window that runs past 60, then
    // the source loops and the clock restarts at 0.
    for (const playhead of [55, 58, 59.5, 0.2, 1, 3, 5.5, 8]) {
      await timeline.prepare(playhead, { duration: 60, firstTimestamp: 0 });

      const state = timeline.getState();

      expect(state.bufferStartTime).toBeLessThanOrEqual(playhead);
      expect(state.bufferEndTime).toBeGreaterThanOrEqual(playhead);
      expect(timeline.selectFrame(playhead)?.mediaTime).toBe(
        Math.floor(playhead),
      );
    }
  });

  it("resolves a revisited position the same on a later lap", async () => {
    const timeline = createLoopingTimeline();

    timeline.setTimelineContext?.({ duration: 60, loop: true });
    await timeline.prepare(30, { duration: 60, firstTimestamp: 0 });

    const firstVisitState = timeline.getState();
    const firstVisitFrame = timeline.selectFrame(30);

    for (const playhead of [45, 58, 2, 20, 44, 59, 1, 25, 55]) {
      await timeline.prepare(playhead, { duration: 60, firstTimestamp: 0 });
    }

    await timeline.prepare(30, { duration: 60, firstTimestamp: 0 });

    expect(timeline.getState()).toEqual(firstVisitState);
    expect(timeline.selectFrame(30)).toEqual(firstVisitFrame);
  });

  it("announces a landed load to subscribers", async () => {
    const load = createDeferred<DetectionFrame[]>();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0.5,
      source: { loadFrames: () => load.promise },
    });
    const listener = vi.fn();
    const unsubscribe = timeline.subscribe?.(listener);

    const prepared = timeline.prepare(1.25);

    expect(listener).not.toHaveBeenCalled();

    load.resolve(frames);
    await prepared;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(timeline.selectFrame(1.25)?.mediaTime).toBe(1);

    unsubscribe?.();
    await timeline.prepare(3.75);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still maps an unwrapped loop-crossing time back to the buffered window", async () => {
    const loopFrames: DetectionFrame[] = [
      { detections: [], mediaTime: 0.5 },
      { detections: [], mediaTime: 59.5 },
    ];
    const loadFrames = vi.fn(async () => loopFrames);
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0.5,
      source: { loadFrames },
    });

    timeline.setTimelineContext?.({ duration: 60, loop: true });
    await timeline.prepare(59.5, { duration: 60, firstTimestamp: 0 });
    // A consumer running an unwrapped loop clock asks for 60.5, which is 0.5
    // into the next lap; the nearest representative sits inside the window.
    expect(timeline.selectFrame(60.5)?.mediaTime).toBe(0.5);
    const state = timeline.getState();
    expect(state.requestedStartTime).toBe(59);
    expect(state.requestedEndTime).toBe(61.5);
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

  it("loads a loop-crossing window without waiting when no gate is configured", async () => {
    const source = {
      loadFrames: vi.fn(async () => []),
      waitForRange: vi.fn(async () => undefined),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 2,
      bufferBehindSeconds: 0,
      source,
    });

    timeline.setTimelineContext?.({ duration: 5, loop: true });
    await timeline.prepare(4.75, {
      duration: 5,
      firstTimestamp: 0,
      gatePlayback: true,
    });

    expect(source.waitForRange).not.toHaveBeenCalled();
    expect(source.loadFrames).toHaveBeenCalledTimes(2);
    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 4.75, 5);
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 0, 1.75);
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
    // The landed window leaves 1s of lead, under the refill threshold, so the
    // next window is already fetching while this one still answers.
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 4, 9);
    expect(timeline.selectFrame(4)?.mediaTime).toBe(0);
    secondLoad.resolve([frames[2]]);
  });

  it("stops refilling once the window covers the whole looping media", async () => {
    const source = {
      loadFrames: vi.fn(async () => [frames[0], frames[1], frames[2]]),
    };
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    timeline.setTimelineContext?.({ duration: 9, loop: true });
    await timeline.prepare(0);

    expect(source.loadFrames).toHaveBeenNthCalledWith(1, 0, 9);

    for (let mediaTime = 0; mediaTime < 9; mediaTime += 1 / 30) {
      await timeline.prepare(mediaTime);
    }

    expect(source.loadFrames).toHaveBeenCalledOnce();
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

  it("keeps a live retention window patching instead of reloading", async () => {
    const writableSource = createWritableDetectionFrameSource({
      datasetId: "live-retention",
      retention: {
        mode: DetectionFrameRetentionMode.PersistWindow,
        windowSeconds: 2,
      },
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
      bufferAheadSeconds: 1,
      bufferBehindSeconds: 1,
      source,
    });

    for (let frameIndex = 0; frameIndex < 150; frameIndex += 1) {
      await writableSource.appendFrames([
        {
          detections: [{ id: `live-${frameIndex}` }],
          endTime: (frameIndex + 1) / 30,
          frameIndex,
          mediaTime: frameIndex / 30,
        },
      ]);
      await timeline.prepare(frameIndex / 30);
    }

    // Eviction is reported as its own bounded range, so the timeline keeps
    // patching the two ranges that moved. A per-append window rewrite would
    // have reloaded the retained window 150 times over.
    expect(loadedFrameRecords).toBeLessThanOrEqual(300);
    expect(timeline.selectFrame(149 / 30)?.frameIndex).toBe(149);
    expect(writableSource.getSummary()).toMatchObject({ startTime: 3 });
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

  it("fetches the next window while the current one still leads the playhead", async () => {
    const source = createCountingSecondFrameSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    expect(timeline.getState().bufferEndTime).toBe(10);
    expect(source.loadFrames).toHaveBeenCalledOnce();

    // Five and a half seconds of lead left, above the five-second threshold:
    // nothing yet.
    timeline.prefetch(4.5);
    expect(source.loadFrames).toHaveBeenCalledOnce();

    timeline.prefetch(5.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));
    expect(source.loadFrames).toHaveBeenNthCalledWith(2, 5, 15.5);
  });

  it("keeps answering a media time while the next window loads", async () => {
    const pending = createDeferred<readonly DetectionFrame[]>();
    const source = createCountingSecondFrameSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    source.loadFrames.mockImplementationOnce(() => pending.promise);
    timeline.prefetch(6);
    await vi.waitFor(() =>
      expect(timeline.getState().status).toBe(DetectionBufferStatus.Loading),
    );

    expect(timeline.selectFrame(6)?.mediaTime).toBe(6);
    expect(timeline.selectFrame(9)?.mediaTime).toBe(9);

    pending.resolve([]);
  });

  it("never loses the playhead across a window handover during playback", async () => {
    const source = createCountingSecondFrameSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    const blanks: number[] = [];

    // The first window is cold; playback starts once it has landed.
    await timeline.prepare(0);

    for (let frame = 0; frame <= 30 * 40; frame += 1) {
      const mediaTime = frame / 30;

      timeline.prefetch(mediaTime);
      await Promise.resolve();

      if (!timeline.selectFrame(mediaTime)) {
        blanks.push(mediaTime);
      }
    }

    expect(blanks).toEqual([]);
  });

  it("does not supersede a load that still covers the advancing playhead", async () => {
    const pending = createDeferred<readonly DetectionFrame[]>();
    const source = createCountingSecondFrameSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    source.loadFrames.mockImplementationOnce(() => pending.promise);
    void timeline.prepare(10.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));

    // Every frame of the load's flight asks again from a slightly later
    // playhead. The window already loading still covers all of them.
    for (let frame = 1; frame <= 30; frame += 1) {
      void timeline.prepare(10.5 + frame / 30);
    }

    expect(source.loadFrames).toHaveBeenCalledTimes(2);

    pending.resolve([]);
  });

  it("supersedes a load the playhead has outrun", async () => {
    const pending = createDeferred<readonly DetectionFrame[]>();
    const source = createCountingSecondFrameSource();
    const timeline = createBufferedDetectionTimeline({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      source,
    });

    await timeline.prepare(0);
    source.loadFrames.mockImplementationOnce(() => pending.promise);
    void timeline.prepare(10.5);
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalledTimes(2));

    void timeline.prepare(40);

    expect(source.loadFrames).toHaveBeenNthCalledWith(3, 39.5, 50);

    pending.resolve([]);
  });
});

function createLoopingTimeline() {
  return createBufferedDetectionTimeline({
    bufferAheadSeconds: 7,
    bufferBehindSeconds: 0.5,
    source: {
      async loadFrames(startTime, endTime) {
        const loaded: DetectionFrame[] = [];

        for (
          let mediaTime = Math.max(0, Math.ceil(startTime));
          mediaTime <= Math.min(60, endTime);
          mediaTime += 1
        ) {
          loaded.push({ detections: [], mediaTime });
        }

        return loaded;
      },
    },
  });
}

/** One frame per media second, so a window's coverage is countable. */
function createCountingSecondFrameSource() {
  return {
    loadFrames: vi.fn(
      async (
        startTime: number,
        endTime: number,
      ): Promise<readonly DetectionFrame[]> => {
        const loaded: DetectionFrame[] = [];

        for (
          let mediaTime = Math.max(0, Math.ceil(startTime));
          mediaTime <= endTime;
          mediaTime += 1
        ) {
          loaded.push({ detections: [], endTime: mediaTime + 1, mediaTime });
        }

        return loaded;
      },
    ),
  };
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
