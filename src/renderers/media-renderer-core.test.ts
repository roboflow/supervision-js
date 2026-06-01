import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "#detections/buffered-detection-timeline";
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
