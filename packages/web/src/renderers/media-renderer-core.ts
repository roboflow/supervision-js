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
  type MediaRendererPresentation,
} from "#types/media-renderer";
import { MediaInteractionMode } from "supervision-js-core";
import type { RenderPreparationPlaybackGateOptions } from "#types/render-preparation";
import { createMediaRendererRuntimeState } from "./media-renderer-state";
import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
} from "./media-renderer-scene";

export interface MediaRendererCoreProviders {
  openMediaSource(src: string | URL | Request): Promise<DecodedMediaSource>;
  createScene(options: MediaRendererSceneOptions): Promise<MediaRendererScene>;
}

export async function createMediaRendererCore(
  options: MediaRendererOptions,
  providers: MediaRendererCoreProviders,
): Promise<MediaRenderer> {
  const fit = options.fit ?? MediaRendererFit.Contain;
  const initialPlaybackRate = options.playbackRate ?? 1;
  if (!Number.isFinite(initialPlaybackRate) || initialPlaybackRate <= 0) {
    throw new RangeError(
      "playbackRate must be a finite number greater than zero.",
    );
  }
  let currentPresentation: MediaRendererPresentation = {
    annotationOverlayStyle: options.annotationOverlayStyle,
    backgroundColor: options.backgroundColor,
    boxStyle: options.boxStyle,
    focusStyle: options.focusStyle,
    interactionStyle: options.interactionStyle,
    keypointStyle: options.keypointStyle,
    labelStyle: options.labelStyle,
    maskStyle: options.maskStyle,
    polygonStyle: options.polygonStyle,
    polylineStyle: options.polylineStyle,
    visibility: options.visibility,
  };
  let detectionTimeline: BufferedDetectionTimeline | undefined;
  let mediaScene: MediaRendererScene | undefined;
  const runtimeState = createMediaRendererRuntimeState({
    fit,
    playbackRate: initialPlaybackRate,
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
  let navigationVersion = 0;

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
      const requestVersion = ++navigationVersion;
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
        if (
          requestVersion !== navigationVersion ||
          runtimeState.isDestroyed()
        ) {
          sample.close();
          return;
        }

        await prepareAndPresentSample(sample);
        playbackController.seek(runtimeState.currentTime());

        if (wasPlaying) {
          runtimeState.setPlaying();
          playbackController.play();
        }
      } catch (error) {
        if (
          requestVersion !== navigationVersion ||
          runtimeState.isDestroyed()
        ) {
          return;
        }
        runtimeState.setRenderError(error);
        throw error;
      }
    },

    async stepForward() {
      await stepToAdjacentSample("forward");
    },

    async stepBackward() {
      await stepToAdjacentSample("backward");
    },

    setPlaybackRate(playbackRate) {
      if (runtimeState.isDestroyed()) {
        return;
      }
      if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
        throw new RangeError(
          "playbackRate must be a finite number greater than zero.",
        );
      }

      playbackController?.setPlaybackRate(playbackRate);
      runtimeState.setPlaybackRate(playbackRate);
    },

    async refresh() {
      if (runtimeState.isDestroyed()) {
        return;
      }
      if (!mediaScene) {
        throw new Error("Media renderer is not ready.");
      }

      const mediaTime = runtimeState.currentTime();
      const requestVersion = navigationVersion;
      await detectionTimeline?.prepare(mediaTime, {
        duration: runtimeState.duration(),
        firstTimestamp,
      });
      if (requestVersion !== navigationVersion || runtimeState.isDestroyed()) {
        return;
      }
      const presentedSample = mediaScene.setPresentation(
        currentPresentation,
        mediaTime,
      );
      if (presentedSample) {
        runtimeState.recordPresentationUpdate(presentedSample);
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

      currentPresentation = presentation;
      const presentedSample = mediaScene?.setPresentation(
        currentPresentation,
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
    mediaScene = await providers.createScene({
      annotationOverlayStyle: options.annotationOverlayStyle,
      backgroundColor: options.backgroundColor,
      boxStyle: options.boxStyle,
      canInteract: () => canInteract(options, runtimeState.isPlaybackActive()),
      container: options.container,
      detectionTimeline,
      diagnostics: options.diagnostics,
      editingEngine: options.editingEngine,
      fit,
      focusStyle: options.focusStyle,
      interaction: options.interaction,
      interactionStyle: options.interactionStyle,
      keypointStyle: options.keypointStyle,
      labelStyle: options.labelStyle,
      maskBrush:
        options.createMaskBrush?.(mediaDimensions) ?? options.maskBrush,
      maskStyle: options.maskStyle,
      maxDevicePixelRatio: options.maxDevicePixelRatio,
      polygonStyle: options.polygonStyle,
      polylineStyle: options.polylineStyle,
      previewOverlay: options.previewOverlay,
      renderPreparation: options.renderPreparation,
      visibility: options.visibility,
    });
    runtimeState.setRendererBackend(mediaScene.rendererBackend);
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
      playbackRate: initialPlaybackRate,
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

  async function stepToAdjacentSample(direction: "forward" | "backward") {
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

    const requestVersion = ++navigationVersion;
    playbackController.pause();
    runtimeState.setPaused();
    const currentTime = runtimeState.currentTime();
    const epsilon = 1e-6;
    let sample: DecodedVideoSample | null = null;

    try {
      if (direction === "backward") {
        sample = await sampleSink.getSample(
          Math.max(firstTimestamp, currentTime - epsilon),
          { skipLiveWait: true },
        );
      } else {
        const iterator = sampleSink.samples(currentTime + epsilon, undefined, {
          skipLiveWait: true,
        });
        try {
          const result = await iterator.next();
          sample = result.done ? null : result.value;
        } finally {
          await iterator.return?.();
        }
      }

      if (!sample) {
        return;
      }
      if (requestVersion !== navigationVersion || runtimeState.isDestroyed()) {
        sample.close();
        sample = null;
        return;
      }

      const sampleToPresent = sample;
      sample = null;
      await prepareAndPresentSample(sampleToPresent);
      playbackController.seek(runtimeState.currentTime());
    } catch (error) {
      sample?.close();
      if (requestVersion !== navigationVersion || runtimeState.isDestroyed()) {
        return;
      }
      runtimeState.setRenderError(error);
      throw error;
    }
  }
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
