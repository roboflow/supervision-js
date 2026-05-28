import {
  readFirstDecodedVideoSample,
  type DecodedVideoSampleIterator,
} from "#media/decoded-video-sample-reader";
import type {
  DecodedMediaSource,
  DecodedVideoSample,
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
  const mediaScene = await providers.createScene({
    boxStyle: options.boxStyle,
    container: options.container,
    detectionFrames: options.detectionFrames,
    fit,
  });
  const runtimeState = createMediaRendererRuntimeState({
    fit,
    onFrame: options.onFrame,
    onSource: options.onSource,
  });
  let activeSampleIterator: DecodedVideoSampleIterator | undefined;
  let mediaInput: DisposableMediaInput | undefined;
  let playbackController: MediaPlaybackController | undefined;

  const presentSample = (sample: DecodedVideoSample) => {
    const presentedSample = mediaScene.presentSample(sample);
    runtimeState.recordPresentedSample(presentedSample);
  };

  const stopActiveIterator = () => {
    void activeSampleIterator?.return?.();
    activeSampleIterator = undefined;
  };

  const destroyMediaInput = () => {
    mediaInput?.dispose();
    mediaInput = undefined;
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

      if (runtimeState.isPlaying()) {
        return;
      }

      runtimeState.setPlaying();
      playbackController.play();
    },

    pause() {
      if (runtimeState.isDestroyed() || !runtimeState.isPlaying()) {
        return;
      }

      runtimeState.setPaused();
      playbackController?.pause();
    },

    getState() {
      return runtimeState.snapshot();
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
      mediaScene.destroy();
    },
  };

  runtimeState.emitSourceState();

  try {
    const mediaSource = await providers.openMediaSource(options.src);
    mediaInput = mediaSource.input;

    if (runtimeState.isDestroyed()) {
      destroyMediaInput();
      return renderer;
    }

    const { metadata } = mediaSource;

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

    presentSample(firstSample);
    runtimeState.setReady();
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
      presentSample,
      sampleSink: mediaSource.sampleSink,
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
