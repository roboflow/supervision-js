import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "supervision-js-core";
import { DetectionFrameSelectionMode } from "supervision-js-core";
import { PlaybackGateReach } from "supervision-js-core";
import type {
  DecodedMediaSource,
  DecodedVideoSample,
} from "#media/media-source";
import {
  DetectionTimelineOrigin,
  MediaRendererPlaybackState,
  type MediaRendererOptions,
} from "#types/media-renderer";
import {
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";

import {
  createDeferred,
  createMockSample,
  flushAnimationFrame,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { createMediaRendererCore } from "./media-renderer-core";

/** The harness reports 1280x720 media, so every load carries that space. */
const mediaCoordinateSpaceLoadOptions = {
  coordinateSpace: { height: 720, width: 1280 },
};
import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
} from "./media-renderer-scene";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelSignal,
} from "./presented-frame-channel";

describe("media renderer core", () => {
  it("captures the raw frame from the scene at its presented timestamp", async () => {
    resetMocks();

    const capture = {
      blob: new Blob(["frame"], { type: "image/jpeg" }),
      height: 360,
      mediaTime: 1.25,
      type: "image/jpeg",
      width: 640,
    };
    const scene = createScene({
      captureFrame: vi.fn(async () => capture),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: createSource([
          createMockSample(1.25, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    await expect(renderer.captureFrame()).resolves.toEqual(capture);
    expect(scene.captureFrame).toHaveBeenCalledWith(undefined);

    renderer.destroy();
    await expect(renderer.captureFrame()).rejects.toThrow(
      "Media renderer has been destroyed.",
    );
  });

  it("does not enter buffering when render preparation is already ready", async () => {
    resetMocks();

    const samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
    ] as unknown as DecodedVideoSample[];
    const onState = vi.fn();
    const scene = createScene({
      waitForRenderPreparation: vi.fn(async () => undefined),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        onState,
        renderPreparation: {
          playbackGate: {
            enabled: true,
            requiredAheadSeconds: 0.04,
          },
        },
        source: createSource(samples),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    expect(scene.setTimelineContext).toHaveBeenCalledWith({
      duration: 0.12,
      loop: false,
    });

    await renderer.play();
    flushAnimationFrame(40);

    await vi.waitFor(() => {
      expect(scene.presentSample).toHaveBeenCalledTimes(2);
    });
    expect(onState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    );

    renderer.destroy();
  });

  it("buffers playback until render preparation reaches the requested lookahead", async () => {
    resetMocks();

    const renderPreparation = createDeferred<void>();
    const samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ] as unknown as DecodedVideoSample[];
    const scene = createScene({
      waitForRenderPreparation: vi.fn(() => renderPreparation.promise),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        renderPreparation: {
          playbackGate: {
            enabled: true,
            requiredAheadSeconds: 0.04,
          },
        },
        source: createSource(samples),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    expect(scene.presentSample).toHaveBeenCalledOnce();

    await renderer.play();
    flushAnimationFrame(40);

    await vi.waitFor(() => {
      expect(scene.waitForRenderPreparation).toHaveBeenCalledWith(
        0.04,
        {
          enabled: true,
          requiredAheadSeconds: 0.04,
        },
        expect.any(AbortSignal),
      );
    });
    expect(scene.presentSample).toHaveBeenCalledOnce();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );

    renderPreparation.resolve();

    await vi.waitFor(() => {
      expect(scene.presentSample).toHaveBeenCalledTimes(2);
    });
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    renderer.destroy();
  });

  it("resumes playback after seeking while buffering", async () => {
    resetMocks();

    const renderPreparation = createDeferred<void>();
    const samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ] as unknown as DecodedVideoSample[];
    const scene = createScene({
      waitForRenderPreparation: vi.fn(() => renderPreparation.promise),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        renderPreparation: {
          playbackGate: { enabled: true, requiredAheadSeconds: 0.04 },
        },
        source: createSource(samples, { duration: 1 }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(renderer.getState().playbackState).toBe(
        MediaRendererPlaybackState.Buffering,
      );
    });

    // Buffering means playback was requested and is waiting for data, and
    // seeking stops the decoder, so the seek has to hand playback back.
    await renderer.seek(0.04);

    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    // A later play() must not be a no-op either: it is what a host calls after
    // its own pause/seek shim, and playback has to actually run.
    const presentedBeforeResume = countPresentedSamples(scene);

    await renderer.play();
    renderPreparation.resolve();
    await presentNextSample(scene, 100);

    expect(countPresentedSamples(scene)).toBeGreaterThan(presentedBeforeResume);
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.08,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    renderer.destroy();
  });

  it("settles a paused seek taken while buffering", async () => {
    resetMocks();

    const renderPreparation = createDeferred<void>();
    const samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ] as unknown as DecodedVideoSample[];
    const scene = createScene({
      waitForRenderPreparation: vi.fn(() => renderPreparation.promise),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        renderPreparation: {
          playbackGate: { enabled: true, requiredAheadSeconds: 0.04 },
        },
        source: createSource(samples, { duration: 1 }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(renderer.getState().playbackState).toBe(
        MediaRendererPlaybackState.Buffering,
      );
    });

    renderer.pause();
    await renderer.seek(0.04);

    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      playbackState: MediaRendererPlaybackState.Paused,
    });

    const presentedBeforeResume = countPresentedSamples(scene);

    renderPreparation.resolve();
    await renderer.play();
    await presentNextSample(scene, 100);

    expect(countPresentedSamples(scene)).toBeGreaterThan(presentedBeforeResume);
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.08,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    renderer.destroy();
  });

  it("plays through render preparation that never finishes", async () => {
    resetMocks();

    const renderPreparation = createDeferred<void>();
    const samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ] as unknown as DecodedVideoSample[];
    const onState = vi.fn();
    const scene = createScene({
      waitForRenderPreparation: vi.fn(() => renderPreparation.promise),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        onState,
        source: createSource(samples),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    expect(scene.presentSample).toHaveBeenCalledOnce();

    await renderer.play();
    flushAnimationFrame(40);

    await vi.waitFor(() => {
      expect(scene.presentSample).toHaveBeenCalledTimes(2);
    });
    expect(scene.waitForRenderPreparation).not.toHaveBeenCalled();
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      playbackState: MediaRendererPlaybackState.Playing,
    });
    expect(onState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    );

    renderPreparation.resolve();
    renderer.destroy();
  });

  it("surfaces strict worker failures", async () => {
    resetMocks();

    let sceneOptions: MediaRendererSceneOptions | undefined;
    const onDiagnostics = vi.fn();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        renderPreparation: {
          mode: RenderPreparationMode.Worker,
          onDiagnostics,
        },
        source: createSource([
          createMockSample(0, 0.04) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) => {
          sceneOptions = options;
          return createScene();
        }),
        openMediaSource: vi.fn(),
      },
    );

    await renderer.play();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    sceneOptions?.renderPreparation?.onDiagnostics?.({
      artifacts: [],
      executionMode: RenderPreparationExecutionMode.Worker,
      message: "worker crashed",
      workerStatus: RenderPreparationWorkerStatus.Error,
    });

    expect(onDiagnostics).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      playbackState: MediaRendererPlaybackState.Error,
      source: { errorMessage: "worker crashed" },
    });
    await expect(renderer.play()).rejects.toThrow("worker crashed");

    renderer.destroy();
  });

  it("passes looping media context to the detection hot buffer before initial prepare", async () => {
    resetMocks();

    const samples = [
      createMockSample(4.75, 0),
    ] as unknown as DecodedVideoSample[];
    const detectionSource = {
      loadFrames: vi.fn(async () => []),
    };
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionBuffer: {
          bufferAheadSeconds: 2,
          bufferBehindSeconds: 0.5,
        },
        detectionSource,
        loop: true,
        source: createSource(samples, {
          duration: 5,
          firstTimestamp: 4.75,
        }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    expect(detectionSource.loadFrames).toHaveBeenCalledTimes(2);
    // The renderer hands its media coordinate space to every load so a
    // composing source can project children before it flattens them.
    expect(detectionSource.loadFrames).toHaveBeenNthCalledWith(
      1,
      4.25,
      5,
      mediaCoordinateSpaceLoadOptions,
    );
    expect(detectionSource.loadFrames).toHaveBeenNthCalledWith(
      2,
      0,
      1.75,
      mediaCoordinateSpaceLoadOptions,
    );

    renderer.destroy();
  });

  it("aligns zero-based detections to a non-zero media start timestamp", async () => {
    resetMocks();

    const samples = [
      createMockSample(0.6, 1 / 30),
    ] as unknown as DecodedVideoSample[];
    const detectionSource = {
      loadFrames: vi.fn(async () => [
        {
          detections: [{ id: "mask-0" }],
          endTime: 1 / 30,
          frameIndex: 0,
          mediaTime: 0,
        },
      ]),
    };
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionBuffer: {
          bufferAheadSeconds: 0,
          bufferBehindSeconds: 0,
          frameIndexOriginTime: 0,
          frameRate: 30,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        detectionSource,
        detectionTimelineOrigin: DetectionTimelineOrigin.MediaStart,
        loop: false,
        source: createSource(samples, {
          duration: 1,
          firstTimestamp: 0.6,
        }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) =>
          createScene({
            presentSample: vi.fn((sample) => {
              const activeFrame = options.detectionTimeline.selectFrame(
                sample.timestamp,
              );
              sample.close();
              return {
                activeDetectionCount: activeFrame?.detections.length ?? 0,
                activeDetectionFrameIndex: activeFrame?.frameIndex ?? null,
                activeDetectionFrameTime: activeFrame?.mediaTime ?? null,
                detectionBuffer: createIdleDetectionBufferState(),
                drawnMaskFrameTime: null,
                maskHeldStale: false,
                duration: sample.duration,
                mediaTime: sample.timestamp,
                presentedFrameSerial: 1,
              };
            }),
          }),
        ),
        openMediaSource: vi.fn(),
      },
    );

    expect(detectionSource.loadFrames).toHaveBeenCalledWith(
      0,
      0,
      mediaCoordinateSpaceLoadOptions,
    );
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 0,
      activeDetectionFrameTime: 0.6,
      currentTime: 0.6,
    });

    renderer.destroy();
  });

  it("loads detections for the presented sample timestamp after seek", async () => {
    resetMocks();

    const samples = [
      createMockSample(0, 1 / 30),
      createMockSample(1 / 30, 1 / 30),
    ] as unknown as DecodedVideoSample[];
    const detectionSource = {
      loadFrames: vi.fn(async () => []),
    };
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionBuffer: {
          bufferAheadSeconds: 0,
          bufferBehindSeconds: 0,
          frameRate: 30,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        detectionSource,
        loop: false,
        source: createSource(samples, {
          duration: 2 / 30,
        }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    detectionSource.loadFrames.mockClear();

    await renderer.seek(1.5 / 30);

    expect(detectionSource.loadFrames).toHaveBeenCalledWith(
      1 / 30,
      1 / 30,
      mediaCoordinateSpaceLoadOptions,
    );
    expect(renderer.getState()).toMatchObject({
      currentTime: 1 / 30,
    });

    renderer.destroy();
  });

  it("keeps the latest seek when an older decode resolves afterward", async () => {
    resetMocks();

    const firstSeek = createDeferred<DecodedVideoSample | null>();
    const secondSeek = createDeferred<DecodedVideoSample | null>();
    const initialSample = createMockSample(
      0,
      0.5,
    ) as unknown as DecodedVideoSample;
    const source: MediaRendererOptions["source"] = {
      open: vi.fn(async () => ({
        input: { dispose: vi.fn() },
        metadata: {
          audioTrackCount: 0,
          canRead: true,
          duration: 2,
          firstTimestamp: 0,
          formatMimeType: "video/mp4",
          formatName: "MP4",
          mimeType: "video/mp4",
          primaryVideoHeight: 360,
          primaryVideoWidth: 640,
          trackCount: 1,
          videoTrackCount: 1,
        },
        sampleSink: {
          getSample: vi.fn((timestamp: number) =>
            timestamp < 1 ? firstSeek.promise : secondSeek.promise,
          ),
          async *samples() {
            yield initialSample;
          },
        },
      })),
    };
    const scene = createScene();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    const olderRequest = renderer.seek(0.5);
    const latestRequest = renderer.seek(1.5);
    secondSeek.resolve(
      createMockSample(1.5, 0.5) as unknown as DecodedVideoSample,
    );
    await latestRequest;
    firstSeek.resolve(
      createMockSample(0.5, 0.5) as unknown as DecodedVideoSample,
    );
    await olderRequest;

    expect(renderer.getState().currentTime).toBe(1.5);
    expect(scene.presentSample).toHaveBeenLastCalledWith(
      expect.objectContaining({ timestamp: 1.5 }),
    );

    renderer.destroy();
  });

  it("keeps the latest seek when an older prepare resolves afterward", async () => {
    resetMocks();

    const prepareGate = createDeferred<void>();
    let releaseOlderPrepare: (() => void) | undefined;
    const olderPrepareEntered = new Promise<void>((resolve) => {
      releaseOlderPrepare = resolve;
    });
    const olderSample = createMockSample(
      0.5,
      0.5,
    ) as unknown as DecodedVideoSample;
    const latestSample = createMockSample(
      1.5,
      0.5,
    ) as unknown as DecodedVideoSample;
    const samples = [
      createMockSample(0, 2),
      olderSample,
      latestSample,
    ] as unknown as DecodedVideoSample[];
    const detectionSource = {
      loadFrames: vi.fn(async (startTime: number) => {
        if (startTime === 0.5) {
          releaseOlderPrepare?.();
          await prepareGate.promise;
        }

        return [];
      }),
    };
    const scene = createScene();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionBuffer: {
          bufferAheadSeconds: 0,
          bufferBehindSeconds: 0,
          frameRate: 30,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        detectionSource,
        loop: false,
        source: createSource(samples, {
          duration: 2,
        }),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    vi.mocked(scene.presentSample).mockClear();

    const olderRequest = renderer.seek(0.5);
    await olderPrepareEntered;

    const latestRequest = renderer.seek(1.5);
    await latestRequest;

    expect(renderer.getState().currentTime).toBe(1.5);

    prepareGate.resolve();
    await olderRequest;

    expect(renderer.getState().currentTime).toBe(1.5);
    expect(scene.presentSample).not.toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 0.5 }),
    );
    expect(scene.presentSample).toHaveBeenLastCalledWith(
      expect.objectContaining({ timestamp: 1.5 }),
    );
    expect(olderSample.close).toHaveBeenCalledTimes(1);

    renderer.destroy();
  });

  it("steps through decoded samples without a host-owned decoder", async () => {
    resetMocks();

    const samples = [
      createMockSample(0, 0.04),
      createMockSample(0.04, 0.04),
      createMockSample(0.08, 0.04),
    ] as unknown as DecodedVideoSample[];
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        loop: false,
        source: createSource(samples),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    await renderer.stepForward();
    expect(renderer.getState().currentTime).toBe(0.04);

    await renderer.stepBackward();
    expect(renderer.getState().currentTime).toBe(0);

    renderer.destroy();
  });

  it("re-presents the retained sample when semantic data is invalidated", async () => {
    resetMocks();

    let version = 0;
    const detectionSource = {
      getVersion: () => version,
      loadFrames: vi.fn(async () => []),
    };
    const scene = createScene();
    const sample = createMockSample(0, 0.04);
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionSource,
        source: createSource([sample as unknown as DecodedVideoSample]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    vi.mocked(scene.presentSample).mockClear();
    vi.mocked(scene.setPresentation).mockClear();
    detectionSource.loadFrames.mockClear();
    version += 1;

    await renderer.refresh();

    expect(detectionSource.loadFrames).toHaveBeenCalled();
    expect(scene.presentSample).not.toHaveBeenCalled();
    expect(scene.setPresentation).toHaveBeenCalledWith(expect.any(Object), 0);

    renderer.destroy();
  });

  it("records asynchronous scene visibility updates without presenting another frame", async () => {
    resetMocks();

    let sceneOptions: MediaRendererSceneOptions | undefined;
    const onState = vi.fn();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        onState,
        source: createSource([
          createMockSample(0, 0.04) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) => {
          sceneOptions = options;
          return createScene();
        }),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 0,
      presentedFrames: 1,
    });

    sceneOptions?.onPresentationUpdate?.({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 0,
      activeDetectionFrameTime: 0,
      detectionBuffer: createIdleDetectionBufferState(),
      drawnMaskFrameTime: null,
      maskHeldStale: false,
      mediaTime: 0,
      presentedFrameSerial: 1,
    });

    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 0,
      activeDetectionFrameTime: 0,
      presentedFrames: 1,
    });
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeDetectionCount: 1,
        presentedFrames: 1,
      }),
    );

    renderer.destroy();
  });

  it("publishes source-relative frame timing and media dimensions", async () => {
    resetMocks();

    const onFrame = vi.fn();
    const createMaskBrush = vi.fn(() => ({}) as never);
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        createMaskBrush,
        onFrame,
        source: createSource(
          [createMockSample(4.75, 0.05) as unknown as DecodedVideoSample],
          {
            duration: 2,
            estimatedFrameCount: 60,
            estimatedFrameRate: 30,
            firstTimestamp: 4.75,
            primaryVideoHeight: 360,
            primaryVideoWidth: 640,
          },
        ),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    expect(createMaskBrush).toHaveBeenCalledWith({ height: 360, width: 640 });
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        firstTimestamp: 4.75,
        estimatedFrameIndex: 0,
        frameDuration: 0.05,
        mediaHeight: 360,
        mediaTime: 4.75,
        mediaWidth: 640,
      }),
    );
    expect(renderer.getState()).toMatchObject({
      playbackRate: 1,
      source: {
        estimatedFrameCount: 60,
        estimatedFrameRate: 30,
        firstTimestamp: 4.75,
      },
    });

    renderer.destroy();
  });

  it("records frame render timings in state and frame diagnostics", async () => {
    resetMocks();

    const renderTimings = {
      boxMs: 0.2,
      fitMs: 0.05,
      focusMs: 0.08,
      interactionMs: 0.1,
      labelMs: 0.3,
      maskMs: 0.4,
      mediaUploadMs: 1.2,
      totalMs: 2.25,
    };
    const onFrame = vi.fn();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        onFrame,
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () =>
          createScene({
            presentSample: vi.fn((sample) => {
              sample.close();

              return {
                activeDetectionCount: 0,
                activeDetectionFrameIndex: null,
                activeDetectionFrameTime: null,
                detectionBuffer: createIdleDetectionBufferState(),
                drawnMaskFrameTime: null,
                maskHeldStale: false,
                mediaTime: sample.timestamp,
                presentedFrameSerial: 1,
                renderTimings,
              };
            }),
          }),
        ),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().lastFrameRenderTimings).toEqual(renderTimings);
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ renderTimings }),
    );

    renderer.destroy();
  });

  it("exposes the active detection frame and forwards programmatic selection", async () => {
    resetMocks();

    const detectionFrame = {
      detections: [
        {
          id: "player-1",
          rect: { height: 30, width: 20, x: 10, y: 15 },
        },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const scene = createScene({
      setSelectedDetection: vi.fn(() => null),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionFrames: [detectionFrame],
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getActiveDetectionFrame()).toMatchObject(detectionFrame);
    expect(renderer.setSelectedDetection({ detectionIndex: 0 })).toBeNull();
    expect(scene.setSelectedDetection).toHaveBeenCalledWith(
      { detectionIndex: 0 },
      0,
    );

    renderer.destroy();
  });

  it("forwards runtime render quality changes to the scene", async () => {
    resetMocks();

    const scene = createScene();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    renderer.setRenderQuality({ maxDevicePixelRatio: 1.5 });

    expect(scene.setRenderQuality).toHaveBeenCalledWith(1.5);

    renderer.destroy();
  });

  it("exposes renderer-resolved detection label bounds", async () => {
    resetMocks();

    const labelBounds = { height: 18, width: 42, x: 12, y: 8 };
    const scene = createScene({
      getDetectionLabelBounds: vi.fn(() => labelBounds),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => scene),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getDetectionLabelBounds("player-1")).toEqual(labelBounds);
    expect(scene.getDetectionLabelBounds).toHaveBeenCalledWith("player-1");

    renderer.destroy();
  });

  it("counts the frames a push producer presents", async () => {
    resetMocks();

    const producer = createPushProducer();
    let sceneOptions: MediaRendererSceneOptions | undefined;
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: producer.source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) => {
          sceneOptions = options;
          return createScene();
        }),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().presentedFrames).toBe(0);

    for (const [index, mediaTime] of [0, 0.04, 0.08].entries()) {
      sceneOptions?.onPresentationUpdate?.(
        createPresentedSample(mediaTime, index + 1),
      );
      producer.setTimeMs(mediaTime * 1000);
    }

    expect(renderer.getState()).toMatchObject({
      currentTime: 0.08,
      presentedFrames: 3,
    });

    renderer.destroy();
  });

  it("counts a push producer's frame once when a detection load redraws it", async () => {
    resetMocks();

    const producer = createPushProducer();
    let sceneOptions: MediaRendererSceneOptions | undefined;
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: producer.source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) => {
          sceneOptions = options;
          return createScene();
        }),
        openMediaSource: vi.fn(),
      },
    );

    sceneOptions?.onPresentationUpdate?.(createPresentedSample(0.04));
    sceneOptions?.onPresentationUpdate?.({
      ...createPresentedSample(0.04),
      activeDetectionCount: 2,
    });

    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 2,
      presentedFrames: 1,
    });

    renderer.destroy();
  });

  it("counts no frame for a presentation change made between a producer's frames", async () => {
    resetMocks();

    const producer = createPushProducer();
    let sceneOptions: MediaRendererSceneOptions | undefined;
    const scene = createScene({
      setPresentation: vi.fn((_presentation, mediaTime) =>
        createPresentedSample(mediaTime),
      ),
    });
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: producer.source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async (options) => {
          sceneOptions = options;
          return scene;
        }),
        openMediaSource: vi.fn(),
      },
    );

    sceneOptions?.onPresentationUpdate?.(createPresentedSample(0.04));
    producer.setTimeMs(80);
    renderer.setPresentation({ backgroundColor: 0x101010 });
    await renderer.refresh();

    expect(scene.setPresentation).toHaveBeenCalledTimes(2);
    expect(renderer.getState().presentedFrames).toBe(1);

    renderer.destroy();
  });

  it("reports no gate reach when nothing holds playback", async () => {
    resetMocks();

    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().playbackGateReach).toBe(PlaybackGateReach.Off);

    renderer.destroy();
  });

  it("holds every frame of a source the renderer pulls samples from", async () => {
    resetMocks();

    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        renderPreparation: { playbackGate: { enabled: true } },
        source: createSource([
          createMockSample(0, 0) as unknown as DecodedVideoSample,
        ]),
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () =>
          createScene({
            waitForRenderPreparation: vi.fn(async () => undefined),
          }),
        ),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().playbackGateReach).toBe(
      PlaybackGateReach.EveryFrame,
    );

    renderer.destroy();
  });

  it("holds every frame of a producer the render-preparation gate can stop", async () => {
    resetMocks();

    const producer = createPushProducer();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        renderPreparation: { playbackGate: { enabled: true } },
        source: producer.source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () =>
          createScene({
            waitForRenderPreparation: vi.fn(async () => undefined),
          }),
        ),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().playbackGateReach).toBe(
      PlaybackGateReach.EveryFrame,
    );

    renderer.destroy();
  });

  it("holds every frame of a producer the detection gate can stop", async () => {
    resetMocks();

    const producer = createPushProducer();
    const renderer = await createMediaRendererCore(
      {
        autoPlay: false,
        container: {} as HTMLElement,
        detectionBuffer: { playbackGate: { enabled: true } },
        source: producer.source,
      } satisfies MediaRendererOptions,
      {
        createScene: vi.fn(async () => createScene()),
        openMediaSource: vi.fn(),
      },
    );

    expect(renderer.getState().playbackGateReach).toBe(
      PlaybackGateReach.EveryFrame,
    );

    renderer.destroy();
  });
});

/**
 * Drives playback frames until the scene presents another sample.
 *
 * The controller queues decoded samples asynchronously, so one animation frame
 * is not guaranteed to have the due sample in hand yet.
 */
async function presentNextSample(scene: MediaRendererScene, now: number) {
  const presentedBefore = countPresentedSamples(scene);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (countPresentedSamples(scene) > presentedBefore) {
      return;
    }

    flushAnimationFrame(now);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function countPresentedSamples(scene: MediaRendererScene) {
  return vi.mocked(scene.presentSample).mock.calls.length;
}

function createScene(
  overrides: Partial<MediaRendererScene> = {},
): MediaRendererScene {
  return {
    destroy: vi.fn(),
    initializeMedia: vi.fn(),
    presentSample: vi.fn((sample) => {
      sample.close();

      return {
        activeDetectionCount: 0,
        activeDetectionFrameIndex: null,
        activeDetectionFrameTime: null,
        detectionBuffer: createIdleDetectionBufferState(),
        drawnMaskFrameTime: null,
        maskHeldStale: false,
        duration: sample.duration,
        mediaTime: sample.timestamp,
        presentedFrameSerial: 1,
      };
    }),
    rendererBackend: "test",
    setTimelineContext: vi.fn(),
    setPresentation: vi.fn(),
    setRenderQuality: vi.fn(),
    ...overrides,
  };
}

function createSource(
  samples: DecodedVideoSample[],
  metadataOverrides: Partial<DecodedMediaSource["metadata"]> = {},
): MediaRendererOptions["source"] {
  const source: DecodedMediaSource = {
    input: {
      dispose: vi.fn(),
    },
    metadata: {
      audioTrackCount: 0,
      canRead: true,
      duration: 0.12,
      firstTimestamp: 0,
      formatMimeType: "video/mp4",
      formatName: "MP4",
      mimeType: "video/mp4",
      primaryVideoHeight: 720,
      primaryVideoWidth: 1280,
      trackCount: 1,
      videoTrackCount: 1,
      ...metadataOverrides,
    },
    sampleSink: {
      async getSample(timestamp) {
        return (
          samples
            .slice()
            .reverse()
            .find((sample) => sample.timestamp <= timestamp) ?? null
        );
      },
      async *samples(startTimestamp = 0) {
        for (const sample of samples) {
          if (sample.timestamp >= startTimestamp) {
            yield sample;
          }
        }
      },
    },
  };

  return {
    open: vi.fn(async () => source),
  };
}

function createPresentedSample(mediaTime: number, presentedFrameSerial = 1) {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    detectionBuffer: createIdleDetectionBufferState(),
    drawnMaskFrameTime: null,
    maskHeldStale: false,
    mediaTime,
    presentedFrameSerial,
  };
}

/**
 * A media source that owns its own playhead: the renderer pulls no samples
 * from it, and frames reach runtime state through the scene.
 */
function createPushProducer() {
  const listeners = new Map<PresentedFrameChannelSignal, Set<() => void>>([
    ["rate", new Set()],
    ["seeking", new Set()],
    ["state", new Set()],
    ["time", new Set()],
  ]);
  let timeMs = 0;

  const engine: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => 4000,
    getPlaybackRate: () => 1,
    getSeeking: () => false,
    getStatus: () => "READY",
    getPlayhead: () => ({
      frame: { index: Math.trunc(timeMs / 1000), ticks: timeMs },
      mediaTimeS: timeMs / 1000,
    }),
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    setPlaybackRate: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: (signal, listener) => {
      listeners.get(signal)?.add(listener);
      return () => listeners.get(signal)?.delete(listener);
    },
  };
  const source: DecodedMediaSource & {
    readonly engine: PresentedFrameChannel;
  } = {
    engine,
    input: { dispose: vi.fn() },
    metadata: {
      audioTrackCount: 0,
      canRead: true,
      duration: 4,
      firstTimestamp: 0,
      formatMimeType: null,
      formatName: "video-engine",
      mimeType: null,
      primaryVideoHeight: 720,
      primaryVideoWidth: 1280,
      trackCount: 1,
      videoTrackCount: 1,
    },
    sampleSink: {
      getSample: vi.fn(async () => null),
      samples: vi.fn(async function* () {}),
    },
  };

  return {
    setTimeMs(next: number) {
      timeMs = next;
      for (const listener of listeners.get("time") ?? []) {
        listener();
      }
    },
    source: { open: async () => source },
  };
}
