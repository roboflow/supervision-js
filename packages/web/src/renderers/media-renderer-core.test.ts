import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "supervision-js-core";
import { DetectionFrameSelectionMode } from "supervision-js-core";
import type {
  DecodedMediaSource,
  DecodedVideoSample,
} from "#media/media-source";
import {
  MediaRendererPlaybackState,
  type MediaRendererOptions,
} from "#types/media-renderer";

import {
  createDeferred,
  createMockSample,
  flushAnimationFrame,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { createMediaRendererCore } from "./media-renderer-core";
import type { MediaRendererScene } from "./media-renderer-scene";

describe("media renderer core", () => {
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
      expect(scene.waitForRenderPreparation).toHaveBeenCalledWith(0.04, {
        enabled: true,
        requiredAheadSeconds: 0.04,
      });
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
    expect(detectionSource.loadFrames).toHaveBeenNthCalledWith(1, 4.25, 5);
    expect(detectionSource.loadFrames).toHaveBeenNthCalledWith(2, 0, 1.75);

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

    expect(detectionSource.loadFrames).toHaveBeenCalledWith(1 / 30, 1 / 30);
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
        frameDuration: 0.05,
        mediaHeight: 360,
        mediaTime: 4.75,
        mediaWidth: 640,
      }),
    );
    expect(renderer.getState()).toMatchObject({
      playbackRate: 1,
      source: { firstTimestamp: 4.75 },
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
                mediaTime: sample.timestamp,
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
});

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
        duration: sample.duration,
        mediaTime: sample.timestamp,
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
