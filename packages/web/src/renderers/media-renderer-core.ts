import { createArrayDetectionFrameSource } from "supervision-js-core";
import {
  createBufferedDetectionTimeline,
  createIdleDetectionBufferState,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
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
import { MediaInteractionMode } from "supervision-js-core";
import type { RenderPreparationPlaybackGateOptions } from "#types/render-preparation";
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

    getActiveDetectionFrame() {
      return detectionTimeline?.selectFrame(runtimeState.currentTime()) ?? null;
    },

    setSelectedDetection(selection) {
      if (runtimeState.isDestroyed()) {
        return null;
      }

      return (
        mediaScene?.setSelectedDetection?.(
          selection,
          runtimeState.currentTime(),
        ) ?? null
      );
    },

    setPresentation(presentation) {
      if (runtimeState.isDestroyed()) {
        return;
      }

      const presentedSample = mediaScene?.setPresentation(
        presentation,
        runtimeState.currentTime(),
      );

      if (presentedSample) {
        runtimeState.recordPresentationUpdate(presentedSample);
      }
    },

    setRenderQuality(quality) {
      if (runtimeState.isDestroyed()) {
        return;
      }

      mediaScene?.setRenderQuality(quality.maxDevicePixelRatio);
    },

    setDisplayAdjustments(adjustments) {
      if (!runtimeState.isDestroyed()) {
        mediaScene?.setDisplayAdjustments?.(adjustments);
      }
    },

    getViewportTransform() {
      return (
        mediaScene?.getViewportTransform?.() ?? {
          locked: false,
          scale: 1,
          x: 0,
          y: 0,
        }
      );
    },
    setViewportTransform(transform) {
      mediaScene?.setViewportTransform?.(transform);
    },
    setViewportLocked(locked) {
      mediaScene?.setViewportLocked?.(locked);
    },
    screenToMedia(point) {
      return mediaScene?.screenToMedia?.(point) ?? point;
    },
    mediaToScreen(point) {
      return mediaScene?.mediaToScreen?.(point) ?? point;
    },
    panViewportBy(dx, dy) {
      mediaScene?.panViewportBy?.(dx, dy);
    },
    zoomViewportAt(point, factor) {
      mediaScene?.zoomViewportAt?.(point, factor);
    },
    zoomViewportFromWheel(point, deltaY) {
      mediaScene?.zoomViewportFromWheel?.(point, deltaY);
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
      backgroundColor: options.backgroundColor,
      boxStyle: options.boxStyle,
      annotationOverlayStyle: options.annotationOverlayStyle,
      focusStyle: options.focusStyle,
      container: options.container,
      detectionTimeline,
      fit,
      maxDevicePixelRatio: options.maxDevicePixelRatio,
      canInteract: () => canInteract(options, runtimeState.isPlaybackActive()),
      interaction: options.interaction,
      interactionStyle: options.interactionStyle,
      labelStyle: options.labelStyle,
      maskStyle: options.maskStyle,
      maskBrush: options.maskBrush,
      polygonStyle: options.polygonStyle,
      polylineStyle: options.polylineStyle,
      keypointStyle: options.keypointStyle,
      renderPreparation: options.renderPreparation,
      diagnostics: options.diagnostics,
      visibility: options.visibility,
      editingEngine: options.editingEngine,
      previewOverlay: options.previewOverlay,
    });
    runtimeState.setRendererBackend(mediaScene.rendererBackend);

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
    detectionTimeline.setTimelineContext?.({
      duration: metadata.duration,
      loop: options.loop !== false,
    });
    mediaScene.setTimelineContext?.({
      duration: metadata.duration,
      loop: options.loop !== false,
    });
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
    const detectionPlaybackGate = options.detectionBuffer?.playbackGate;
    const renderPreparationPlaybackGate =
      options.renderPreparation?.playbackGate;
    const shouldGateDetectionPlayback = detectionPlaybackGate?.enabled === true;
    const shouldGateRenderPreparationPlayback =
      renderPreparationPlaybackGate?.enabled === true;
    const shouldGatePlayback =
      shouldGateDetectionPlayback || shouldGateRenderPreparationPlayback;
    const waitForSample = shouldGatePlayback
      ? (sample: DecodedVideoSample) =>
          waitForPlaybackReadiness(sample, {
            detectionEnabled: shouldGateDetectionPlayback,
            renderPreparationEnabled: shouldGateRenderPreparationPlayback,
            renderPreparationOptions: renderPreparationPlaybackGate,
          })
      : undefined;

    async function waitForPlaybackReadiness(
      sample: DecodedVideoSample,
      waitOptions: {
        readonly detectionEnabled: boolean;
        readonly renderPreparationEnabled: boolean;
        readonly renderPreparationOptions:
          RenderPreparationPlaybackGateOptions | undefined;
      },
    ) {
      if (waitOptions.detectionEnabled) {
        await detectionTimeline?.prepare(sample.timestamp, {
          duration: runtimeState.duration(),
          firstTimestamp,
          gatePlayback: true,
        });
      }

      if (waitOptions.renderPreparationEnabled) {
        await mediaScene?.waitForRenderPreparation?.(
          sample.timestamp,
          waitOptions.renderPreparationOptions ?? {},
        );
      }
    }

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
      waitForSample,
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

function canInteract(options: MediaRendererOptions, isPlaybackActive: boolean) {
  if (!options.interaction) {
    return false;
  }

  const mode = options.interaction.mode ?? MediaInteractionMode.PausedOnly;

  if (mode === MediaInteractionMode.Disabled) {
    return false;
  }

  if (mode === MediaInteractionMode.Always) {
    return true;
  }

  return !isPlaybackActive;
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
