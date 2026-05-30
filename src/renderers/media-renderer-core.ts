import { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
import {
  createBufferedDetectionTimeline,
  createIdleDetectionBufferState,
} from "#detections/buffered-detection-timeline";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import {
  readFirstDecodedVideoSample,
  type DecodedVideoSampleIterator,
} from "#media/decoded-video-sample-reader";
import type {
  DecodedMediaSource,
  DecodedVideoSample,
  DecodedVideoSampleSink,
  DisposableMediaInput,
} from "#media/media-source";
import {
  createMediaPlaybackController,
  type MediaPlaybackController,
} from "#playback/media-playback-controller";
import {
  MediaRendererFit,
  type MediaRenderer,
  type MediaRendererOptions,
} from "#types/media-renderer";
import { createMediaRendererRuntimeState } from "./media-renderer-state";
import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
} from "./media-renderer-scene";

export interface MediaRendererCoreProviders {
  openMediaSource(src: string): Promise<DecodedMediaSource>;
  createScene(options: MediaRendererSceneOptions): Promise<MediaRendererScene>;
}

export async function createMediaRendererCore(
  options: MediaRendererOptions,
  providers: MediaRendererCoreProviders,
): Promise<MediaRenderer> {
  const fit = options.fit ?? MediaRendererFit.Contain;
  let detectionTimeline: BufferedDetectionTimeline | undefined;
  let mediaScene: MediaRendererScene | undefined;
  const runtimeState = createMediaRendererRuntimeState({
    fit,
    getDetectionBufferState: () =>
      detectionTimeline?.getState() ?? createIdleDetectionBufferState(),
    onFrame: options.onFrame,
    onSource: options.onSource,
    onState: options.onState,
  });
  let activeSampleIterator: DecodedVideoSampleIterator | undefined;
  let mediaInput: DisposableMediaInput | undefined;
  let playbackController: MediaPlaybackController | undefined;
  let sampleSink: DecodedVideoSampleSink | undefined;
  let firstTimestamp = 0;

  const presentSample = (sample: DecodedVideoSample) => {
    if (!mediaScene) {
      throw new Error("Media renderer scene is not ready.");
    }

    const presentedSample = mediaScene.presentSample(sample);
    runtimeState.recordPresentedSample(presentedSample);
    detectionTimeline?.prefetch(presentedSample.mediaTime);
  };

  const stopActiveIterator = () => {
    void activeSampleIterator?.return?.();
    activeSampleIterator = undefined;
  };

  const destroyMediaInput = () => {
    mediaInput?.dispose();
    mediaInput = undefined;
  };

  const prepareAndPresentSample = async (sample: DecodedVideoSample) => {
    let shouldCloseSample = true;

    try {
      await detectionTimeline?.prepare(sample.timestamp, {
        duration: runtimeState.duration(),
        firstTimestamp,
      });

      presentSample(sample);
      shouldCloseSample = false;
    } finally {
      if (shouldCloseSample) {
        sample.close();
      }
    }
  };

  const renderer: MediaRenderer = {
    async play() {
      if (runtimeState.isDestroyed()) {
        throw new Error("Media renderer has been destroyed.");
      }

      if (runtimeState.isError()) {
        throw new Error(
          runtimeState.errorMessage() ?? "Media renderer is in error state.",
        );
      }

      if (!playbackController) {
        throw new Error("Media renderer is not ready.");
      }

      if (runtimeState.isPlaybackActive()) {
        return;
      }

      runtimeState.setPlaying();
      playbackController.play();
    },

    pause() {
      if (runtimeState.isDestroyed() || !runtimeState.isPlaybackActive()) {
        return;
      }

      runtimeState.setPaused();
      playbackController?.pause();
    },

    async seek(mediaTime) {
      if (runtimeState.isDestroyed()) {
        throw new Error("Media renderer has been destroyed.");
      }

      if (runtimeState.isError()) {
        throw new Error(
          runtimeState.errorMessage() ?? "Media renderer is in error state.",
        );
      }

      if (!playbackController || !sampleSink) {
        throw new Error("Media renderer is not ready.");
      }

      const wasPlaying = runtimeState.isPlaying();
      const targetTime = clampSeekTime({
        duration: runtimeState.duration(),
        firstTimestamp,
        mediaTime,
      });

      playbackController.pause();

      try {
        const sample = await sampleSink.getSample(targetTime, {
          skipLiveWait: true,
        });

        if (!sample) {
          throw new Error("No decoded video sample was found for seek.");
        }

        await prepareAndPresentSample(sample);
        playbackController.seek(runtimeState.currentTime());

        if (wasPlaying) {
          runtimeState.setPlaying();
          playbackController.play();
        }
      } catch (error) {
        runtimeState.setRenderError(error);
        throw error;
      }
    },

    getState() {
      return runtimeState.snapshot();
    },

    setPresentation(presentation) {
      if (runtimeState.isDestroyed()) {
        return;
      }

      mediaScene?.setPresentation(presentation, runtimeState.currentTime());
    },

    destroy() {
      if (runtimeState.isDestroyed()) {
        return;
      }

      runtimeState.markDestroyed();
      playbackController?.destroy();
      stopActiveIterator();
      destroyMediaInput();
      runtimeState.setSourceDestroyed();
      mediaScene?.destroy();
      detectionTimeline?.destroy();
    },
  };

  runtimeState.emitSourceState();

  try {
    if (
      options.detectionFrames !== undefined &&
      options.detectionSource !== undefined
    ) {
      throw new Error(
        "Provide either detectionFrames or detectionSource, not both.",
      );
    }

    detectionTimeline = createBufferedDetectionTimeline({
      source:
        options.detectionSource ??
        createArrayDetectionFrameSource(options.detectionFrames),
      ...options.detectionBuffer,
    });
    mediaScene = await providers.createScene({
      boxStyle: options.boxStyle,
      container: options.container,
      detectionTimeline,
      fit,
      maskStyle: options.maskStyle,
      renderPreparation: options.renderPreparation,
    });

    const mediaSource = await openRendererMediaSource(options, providers);
    mediaInput = mediaSource.input;
    sampleSink = mediaSource.sampleSink;

    if (runtimeState.isDestroyed()) {
      destroyMediaInput();
      return renderer;
    }

    const { metadata } = mediaSource;

    firstTimestamp = metadata.firstTimestamp;
    const mediaDimensions = runtimeState.recordMediaMetadata(metadata);
    mediaScene.initializeMedia(mediaDimensions);
    runtimeState.setSourceReady(metadata);

    const firstSample = await readFirstDecodedVideoSample({
      sampleSink: mediaSource.sampleSink,
      setActiveIterator(iterator) {
        activeSampleIterator = iterator;
      },
      startTimestamp: metadata.firstTimestamp,
    });

    await prepareAndPresentSample(firstSample);
    runtimeState.setReady();
    const shouldGatePlayback =
      options.detectionBuffer?.playbackGate?.enabled === true;
    playbackController = createMediaPlaybackController({
      duration: runtimeState.duration(),
      firstTimestamp: metadata.firstTimestamp,
      initialMediaTime: runtimeState.currentTime(),
      loop: options.loop !== false,
      onCurrentTimeChange(nextCurrentTime) {
        runtimeState.setCurrentTime(nextCurrentTime);
      },
      onEnded() {
        runtimeState.setPaused();
      },
      onError: runtimeState.setRenderError,
      onResume() {
        if (runtimeState.isBuffering()) {
          runtimeState.setPlaying();
        }
      },
      onWaiting() {
        if (runtimeState.isPlaybackActive()) {
          runtimeState.setBuffering();
        }
      },
      presentSample,
      sampleSink: mediaSource.sampleSink,
      waitForSample: shouldGatePlayback
        ? (sample) =>
            detectionTimeline?.prepare(sample.timestamp, {
              duration: runtimeState.duration(),
              firstTimestamp,
              gatePlayback: true,
            }) ?? Promise.resolve()
        : undefined,
    });

    if (options.autoPlay ?? true) {
      await renderer.play();
    }
  } catch (error) {
    if (!runtimeState.isDestroyed()) {
      runtimeState.setRenderError(error);
    }
  }

  return renderer;
}

async function openRendererMediaSource(
  options: MediaRendererOptions,
  providers: MediaRendererCoreProviders,
) {
  if (options.src !== undefined && options.source !== undefined) {
    throw new Error("Provide either src or source, not both.");
  }

  if (options.source) {
    return options.source.open();
  }

  if (options.src === undefined) {
    throw new Error("Provide either src or source.");
  }

  return providers.openMediaSource(options.src);
}

function clampSeekTime(options: {
  readonly mediaTime: number;
  readonly firstTimestamp: number;
  readonly duration: number | null;
}) {
  const mediaTime = Number.isFinite(options.mediaTime)
    ? options.mediaTime
    : options.firstTimestamp;
  const startTime = options.firstTimestamp;
  const endTime =
    options.duration === null
      ? null
      : options.firstTimestamp + Math.max(options.duration, 0);

  return Math.min(Math.max(mediaTime, startTime), endTime ?? mediaTime);
}
