import { openMediabunnyMediaSource } from "../media/mediabunny-media-source";
import type {
  DecodedVideoSample,
  DisposableMediaInput,
} from "../media/media-source";
import {
  createLoadingMediaSourceState,
  createReadyMediaSourceState,
} from "../media/media-source-state";
import {
  createMediaPlaybackController,
  type MediaPlaybackController,
} from "../playback/media-playback-controller";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaFrameDiagnostics,
  type MediaRenderer,
  type MediaRendererOptions,
  type MediaRendererState,
  type MediaSourceState,
} from "../types/media-renderer";
import {
  createPixiMediaScene,
  type PresentedMediaSample,
} from "./pixi-media-scene";

/**
 * Mediabunny owns media reading and video decode; Pixi owns the visible
 * renderer canvas and scene composition. The internal staging canvas is only a
 * texture upload surface and is never appended to the DOM.
 */
export async function createMediaRenderer(
  options: MediaRendererOptions,
): Promise<MediaRenderer> {
  const fit = options.fit ?? MediaRendererFit.Contain;
  const mediaScene = await createPixiMediaScene({
    container: options.container,
    fit,
    overlayFrames: options.overlayFrames,
  });

  let playbackState: MediaRendererPlaybackState =
    MediaRendererPlaybackState.Loading;
  let sourceState = createLoadingMediaSourceState();
  let currentTime = 0;
  let duration: number | null = null;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let presentedFrames = 0;
  let activeOverlayFrameTime: number | null = null;
  let activeOverlayRectCount = 0;
  let destroyed = false;
  let activeSampleIterator:
    | AsyncGenerator<DecodedVideoSample, void, unknown>
    | undefined;
  let mediaInput: DisposableMediaInput | undefined;
  let playbackController: MediaPlaybackController | undefined;

  const emitSourceState = () => {
    options.onSource?.({ ...sourceState });
  };

  const setSourceState = (patch: Partial<MediaSourceState>) => {
    sourceState = {
      ...sourceState,
      ...patch,
    };
    emitSourceState();
  };

  const setRenderError = (error: unknown) => {
    playbackState = MediaRendererPlaybackState.Error;
    setSourceState({
      errorMessage:
        error instanceof Error ? error.message : "Media decode failed.",
      status: MediaSourceStatus.Error,
    });
  };

  const emitFrameDiagnostics = (sample: PresentedMediaSample) => {
    const diagnostics: MediaFrameDiagnostics = {
      activeOverlayFrameTime,
      activeOverlayRectCount,
      currentTime,
      duration,
      expectedDisplayTime: null,
      mediaHeight,
      mediaTime: sample.mediaTime,
      mediaWidth,
      presentedFrames,
    };

    options.onFrame?.(diagnostics);
  };

  const presentSample = (sample: DecodedVideoSample) => {
    const presentedSample = mediaScene.presentSample(sample);
    currentTime = presentedSample.mediaTime;
    presentedFrames += 1;
    activeOverlayFrameTime = presentedSample.activeOverlayFrameTime;
    activeOverlayRectCount = presentedSample.activeOverlayRectCount;
    emitFrameDiagnostics(presentedSample);
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
      if (destroyed) {
        throw new Error("Media renderer has been destroyed.");
      }

      if (playbackState === MediaRendererPlaybackState.Error) {
        throw new Error(
          sourceState.errorMessage ?? "Media renderer is in error state.",
        );
      }

      if (!playbackController) {
        throw new Error("Media renderer is not ready.");
      }

      if (playbackState === MediaRendererPlaybackState.Playing) {
        return;
      }

      playbackState = MediaRendererPlaybackState.Playing;
      playbackController.play();
    },

    pause() {
      if (destroyed || playbackState !== MediaRendererPlaybackState.Playing) {
        return;
      }

      playbackState = MediaRendererPlaybackState.Paused;
      playbackController?.pause();
    },

    getState(): MediaRendererState {
      return {
        activeOverlayFrameTime,
        activeOverlayRectCount,
        currentTime,
        duration,
        fit,
        mediaHeight,
        mediaWidth,
        playbackState,
        presentedFrames,
        source: { ...sourceState },
      };
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      playbackState = MediaRendererPlaybackState.Destroyed;
      playbackController?.destroy();
      stopActiveIterator();
      destroyMediaInput();
      setSourceState({ status: MediaSourceStatus.Destroyed });
      mediaScene.destroy();
    },
  };

  emitSourceState();

  try {
    const mediaSource = await openMediabunnyMediaSource(options.src);
    mediaInput = mediaSource.input;

    if (destroyed) {
      destroyMediaInput();
      return renderer;
    }

    const { metadata } = mediaSource;

    mediaWidth = metadata.primaryVideoWidth;
    mediaHeight = metadata.primaryVideoHeight;
    duration = metadata.duration;
    mediaScene.initializeMedia({ height: mediaHeight, width: mediaWidth });

    sourceState = createReadyMediaSourceState(metadata);
    emitSourceState();

    const firstSampleIterator = mediaSource.sampleSink.samples(
      metadata.firstTimestamp,
      undefined,
      {
        skipLiveWait: true,
      },
    );
    activeSampleIterator = firstSampleIterator;
    const firstSampleResult = await firstSampleIterator.next();
    await firstSampleIterator.return?.();
    activeSampleIterator = undefined;

    if (firstSampleResult.done) {
      throw new Error("No decoded video samples were produced.");
    }

    presentSample(firstSampleResult.value);
    playbackState = MediaRendererPlaybackState.Ready;
    playbackController = createMediaPlaybackController({
      duration,
      firstTimestamp: metadata.firstTimestamp,
      initialMediaTime: currentTime,
      loop: options.loop !== false,
      onCurrentTimeChange(nextCurrentTime) {
        currentTime = nextCurrentTime;
      },
      onEnded() {
        playbackState = MediaRendererPlaybackState.Paused;
      },
      onError: setRenderError,
      presentSample,
      sampleSink: mediaSource.sampleSink,
    });

    if (options.autoPlay ?? true) {
      await renderer.play();
    }
  } catch (error) {
    if (!destroyed) {
      setRenderError(error);
    }
  }

  return renderer;
}
