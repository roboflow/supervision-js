import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "#detections/buffered-detection-timeline";
import { DetectionFrameSelectionMode } from "#types/detection-timeline";
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
} from "../../test/media-renderer-harness";
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
        mediaTime: sample.timestamp,
      };
    }),
    setTimelineContext: vi.fn(),
    setPresentation: vi.fn(),
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
