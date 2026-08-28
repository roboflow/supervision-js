import {
  PlaybackGateReach,
  createArrayDetectionFrameSource,
  createDefaultAnnotationPresentation,
  createProjectedDetectionFrameSource,
  resolveAnnotationRendererPresentation,
} from "supervision-js-core";
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
  DetectionTimelineOrigin,
  MediaRendererFit,
  MediaRendererPlaybackState,
  type MediaRenderer,
  type MediaRendererOptions,
  type MediaRendererPresentation,
} from "#types/media-renderer";
import { MediaInteractionMode } from "supervision-js-core";
import {
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";
import { createOffsetDetectionFrameSource } from "#detections/offset-detection-frame-source";
import { createMediaRendererRuntimeState } from "./media-renderer-state";
import {
  createMediaRendererTransport,
  type MediaRendererTransport,
} from "./media-renderer-transport";
import { resolvePresentedFrameChannel } from "./presented-frame-channel";
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
  const defaultPresentation = createDefaultAnnotationPresentation();
  const resolvePresentation = (
    presentation: MediaRendererPresentation,
  ): MediaRendererPresentation =>
    resolveAnnotationRendererPresentation({
      ...defaultPresentation,
      ...presentation,
    });
  let currentPresentation = resolvePresentation({
    annotationOverlayStyle: options.annotationOverlayStyle,
    backgroundColor: options.backgroundColor,
    boxStyle: options.boxStyle,
    boxCornerStyle: options.boxCornerStyle,
    ellipseStyle: options.ellipseStyle,
    focusStyle: options.focusStyle,
    interactionStyle: options.interactionStyle,
    keypointStyle: options.keypointStyle,
    labelStyle: options.labelStyle,
    maskHaloStyle: options.maskHaloStyle,
    maskStyle: options.maskStyle,
    markerStyle: options.markerStyle,
    polygonStyle: options.polygonStyle,
    polylineStyle: options.polylineStyle,
    renderers: options.renderers,
    visibility: options.visibility,
  });
  let detectionTimeline: BufferedDetectionTimeline | undefined;
  let mediaScene: MediaRendererScene | undefined;
  // A drag is a run of scrubs closed by the seek that lands it, the pairing the
  // transport already keeps for the producer.
  let isSeekGestureInFlight = false;
  const publishPlaybackActivity = () => {
    mediaScene?.setPlaybackActive?.(
      runtimeState.isPlaybackActive() || isSeekGestureInFlight,
    );
  };
  const endSeekGesture = () => {
    isSeekGestureInFlight = false;
    publishPlaybackActivity();
  };
  const adoptPlaybackRate = (playbackRate: number) => {
    runtimeState.setPlaybackRate(playbackRate);
  };
  let presentsOwnFrames = false;
  const runtimeState = createMediaRendererRuntimeState({
    fit,
    playbackRate: initialPlaybackRate,
    getPlaybackGateReach: () =>
      !shouldGatePlayback
        ? PlaybackGateReach.Off
        : // Stopping a producer that owns the playhead is something only the
          // detection gate does, so a self-presenting source held for render
          // preparation alone still waits once and never again.
          presentsOwnFrames && !shouldGateDetectionPlayback
          ? PlaybackGateReach.StartOfPlayback
          : PlaybackGateReach.EveryFrame,
    getDetectionBufferState: () =>
      detectionTimeline?.getState() ?? createIdleDetectionBufferState(),
    onFrame: options.onFrame,
    onSource: options.onSource,
    onState(state) {
      publishPlaybackActivity();
      options.onState?.(state);
    },
  });
  let activeSampleIterator: DecodedVideoSampleIterator | undefined;
  let mediaInput: DisposableMediaInput | undefined;
  let playbackController: MediaPlaybackController | undefined;
  let transport: MediaRendererTransport | undefined;
  let sampleSink: DecodedVideoSampleSink | undefined;
  let firstTimestamp = 0;
  let navigationVersion = 0;

  const adoptTransportPlaybackState = (state: MediaRendererPlaybackState) => {
    // Not gated on isError: the producer owns playback truth here, so a
    // recovery after a transient error must be adopted, not ignored forever.
    if (runtimeState.isDestroyed()) {
      return;
    }

    switch (state) {
      case MediaRendererPlaybackState.Playing:
        runtimeState.setPlaying();
        break;
      case MediaRendererPlaybackState.Buffering:
        runtimeState.setBuffering();
        break;
      case MediaRendererPlaybackState.Paused:
        runtimeState.setPaused();
        break;
      case MediaRendererPlaybackState.Ready:
        runtimeState.setReady();
        break;
      case MediaRendererPlaybackState.Loading:
        runtimeState.setLoading();
        break;
      case MediaRendererPlaybackState.Error:
        runtimeState.setRenderError(new Error("Media playback failed."));
        break;
      default:
        break;
    }
  };

  const handleRenderPreparationDiagnostics = (
    diagnostics: RenderPreparationDiagnostics,
  ) => {
    if (
      options.renderPreparation?.mode === RenderPreparationMode.Worker &&
      diagnostics.workerStatus === RenderPreparationWorkerStatus.Error &&
      !runtimeState.isDestroyed() &&
      !runtimeState.isError()
    ) {
      playbackController?.pause();
      runtimeState.setRenderError(
        new Error(diagnostics.message ?? "Render preparation worker failed."),
      );
    }

    options.renderPreparation?.onDiagnostics?.(diagnostics);
  };

  const detectionPlaybackGate = options.detectionBuffer?.playbackGate;
  const renderPreparationPlaybackGate = options.renderPreparation?.playbackGate;
  const shouldGateDetectionPlayback = detectionPlaybackGate?.enabled === true;
  const shouldGateRenderPreparationPlayback =
    renderPreparationPlaybackGate?.enabled === true;
  const shouldGatePlayback =
    shouldGateDetectionPlayback || shouldGateRenderPreparationPlayback;

  const waitForPlaybackReadiness = async (mediaTime: number) => {
    if (shouldGateDetectionPlayback) {
      await detectionTimeline?.prepare(mediaTime, {
        duration: runtimeState.duration(),
        firstTimestamp,
        gatePlayback: true,
      });
    }

    if (shouldGateRenderPreparationPlayback) {
      await mediaScene?.waitForRenderPreparation?.(
        mediaTime,
        renderPreparationPlaybackGate ?? {},
      );
    }
  };

  /**
   * The detection gate alone, because it is the one that bounds its own wait
   * and gives up on a producer that has stopped answering. Render preparation
   * waits until the artifacts exist, which is a wait to start playback and
   * never one to stop it with.
   */
  const holdForDetectionCoverage = (mediaTime: number) => {
    const prepareOptions = {
      duration: runtimeState.duration(),
      firstTimestamp,
    };

    if (
      detectionTimeline?.needsPlaybackGateWait?.(mediaTime, prepareOptions) !==
      true
    ) {
      return null;
    }

    return detectionTimeline.prepare(mediaTime, {
      ...prepareOptions,
      gatePlayback: true,
    });
  };

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

  const prepareAndPresentSample = async (
    sample: DecodedVideoSample,
    isCurrent: () => boolean = () => true,
  ) => {
    let shouldCloseSample = true;

    try {
      await detectionTimeline?.prepare(sample.timestamp, {
        duration: runtimeState.duration(),
        firstTimestamp,
      });

      if (!isCurrent()) {
        return;
      }

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

      endSeekGesture();

      if (transport) {
        await transport.play();
        return;
      }

      if (!playbackController) {
        throw new Error("Media renderer is not ready.");
      }

      // Buffering is a stalled form of playing, not a settled one: the
      // controller may already have been stopped by a seek taken while the
      // gate was open. Only a run that is genuinely playing can no-op here.
      if (runtimeState.isPlaying()) {
        return;
      }

      runtimeState.setPlaying();
      playbackController.play();
    },

    pause() {
      if (runtimeState.isDestroyed()) {
        return;
      }

      endSeekGesture();

      if (transport) {
        transport.pause();
        return;
      }

      if (!runtimeState.isPlaybackActive()) {
        return;
      }

      runtimeState.setPaused();
      playbackController?.pause();
    },

    async togglePlayback() {
      if (runtimeState.isDestroyed()) {
        return;
      }

      endSeekGesture();

      if (transport) {
        await transport.togglePlayback();
        return;
      }

      if (runtimeState.isPlaybackActive()) {
        renderer.pause();
        return;
      }

      await renderer.play();
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

      const targetTime = clampSeekTime({
        duration: runtimeState.duration(),
        firstTimestamp,
        mediaTime,
      });

      endSeekGesture();

      if (transport) {
        await transport.commit(targetTime);
        return;
      }

      if (!playbackController || !sampleSink) {
        throw new Error("Media renderer is not ready.");
      }

      // A seek taken while buffering should resume playback, not strand it:
      // buffering means playback was requested and is waiting for data.
      const wasPlaying = runtimeState.isPlaybackActive();
      const requestVersion = ++navigationVersion;

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

        await prepareAndPresentSample(
          sample,
          () =>
            requestVersion === navigationVersion && !runtimeState.isDestroyed(),
        );

        if (
          requestVersion !== navigationVersion ||
          runtimeState.isDestroyed()
        ) {
          return;
        }

        playbackController.seek(runtimeState.currentTime());

        if (wasPlaying) {
          runtimeState.setPlaying();
          playbackController.play();
        } else if (runtimeState.isBuffering()) {
          // Seeking always leaves the controller paused. Settle the reported
          // state so the session is paused rather than perpetually buffering.
          runtimeState.setPaused();
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

    scrub(mediaTime) {
      if (runtimeState.isDestroyed() || runtimeState.isError()) {
        return;
      }

      const targetTime = clampSeekTime({
        duration: runtimeState.duration(),
        firstTimestamp,
        mediaTime,
      });

      isSeekGestureInFlight = true;
      publishPlaybackActivity();

      if (transport) {
        transport.scrub(targetTime);
        return;
      }

      void renderer.seek(targetTime).catch(() => undefined);
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

      // Nothing paces the picture until one of the two paths is up, so a
      // non-unit rate would only falsify the state readout.
      if (!transport && !playbackController && playbackRate !== 1) {
        throw new Error("Media renderer is not ready.");
      }

      if (transport) {
        // The producer owns the rate as it owns the playhead, and answers on
        // the rate signal; adopting it there keeps one reading of the truth.
        transport.setPlaybackRate(playbackRate);
        return;
      }

      playbackController?.setPlaybackRate(playbackRate);
      adoptPlaybackRate(playbackRate);
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

    async captureFrame(captureOptions) {
      if (runtimeState.isDestroyed()) {
        throw new Error("Media renderer has been destroyed.");
      }

      if (!mediaScene?.captureFrame) {
        throw new Error("Media renderer is not ready.");
      }

      return mediaScene.captureFrame(captureOptions);
    },

    getRenderCount() {
      return mediaScene?.getRenderCount?.() ?? null;
    },

    getPreparedAnnotationWindow() {
      return mediaScene?.getPreparedAnnotationWindow?.() ?? null;
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

      currentPresentation = resolvePresentation(presentation);
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
    getDetectionLabelBounds(detectionId) {
      return mediaScene?.getDetectionLabelBounds?.(detectionId) ?? null;
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
      transport?.destroy();
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

    const mediaSource = await openRendererMediaSource(options, providers);
    mediaInput = mediaSource.input;
    sampleSink = mediaSource.sampleSink;

    if (runtimeState.isDestroyed()) {
      destroyMediaInput();
      return renderer;
    }

    const { metadata } = mediaSource;

    firstTimestamp = metadata.firstTimestamp;
    // One central projection step for every detection input this renderer can
    // receive: static frames, a caller-owned source, or a composite source.
    // Media dimensions are known here, so a producer can declare its own
    // coordinate space and have vector geometry projected exactly once.
    const detectionSource = createProjectedDetectionFrameSource(
      options.detectionSource ??
        createArrayDetectionFrameSource(options.detectionFrames),
      () =>
        metadata.primaryVideoWidth > 0 && metadata.primaryVideoHeight > 0
          ? {
              height: metadata.primaryVideoHeight,
              width: metadata.primaryVideoWidth,
            }
          : null,
    );
    detectionTimeline = createBufferedDetectionTimeline({
      source:
        options.detectionTimelineOrigin ===
          DetectionTimelineOrigin.MediaStart && metadata.firstTimestamp !== 0
          ? createOffsetDetectionFrameSource(
              detectionSource,
              metadata.firstTimestamp,
            )
          : detectionSource,
      ...options.detectionBuffer,
      ...(options.detectionTimelineOrigin ===
        DetectionTimelineOrigin.MediaStart &&
      options.detectionBuffer?.frameIndexOriginTime !== undefined
        ? {
            frameIndexOriginTime:
              options.detectionBuffer.frameIndexOriginTime +
              metadata.firstTimestamp,
          }
        : {}),
    });
    const presentedFrameChannel = resolvePresentedFrameChannel(mediaSource);

    presentsOwnFrames = presentedFrameChannel !== null;
    const mediaDimensions = runtimeState.recordMediaMetadata(metadata);
    mediaScene = await providers.createScene({
      annotationOverlayStyle: currentPresentation.annotationOverlayStyle,
      backgroundColor: currentPresentation.backgroundColor,
      boxStyle: currentPresentation.boxStyle,
      boxCornerStyle: currentPresentation.boxCornerStyle,
      ellipseStyle: currentPresentation.ellipseStyle,
      canInteract: () => canInteract(options, runtimeState.isPlaybackActive()),
      container: options.container,
      detectionTimeline,
      diagnostics: options.diagnostics,
      editingEngine: options.editingEngine,
      fit,
      focusStyle: currentPresentation.focusStyle,
      interaction: options.interaction,
      interactionStyle: currentPresentation.interactionStyle,
      keypointStyle: currentPresentation.keypointStyle,
      labelStyle: currentPresentation.labelStyle,
      maskBrush:
        options.createMaskBrush?.(mediaDimensions) ?? options.maskBrush,
      maskHaloStyle: currentPresentation.maskHaloStyle,
      maskStyle: currentPresentation.maskStyle,
      markerStyle: currentPresentation.markerStyle,
      maxDevicePixelRatio: options.maxDevicePixelRatio,
      onPresentationUpdate(presentedSample) {
        if (!runtimeState.isDestroyed()) {
          runtimeState.recordPresentationUpdate(presentedSample);
        }
      },
      polygonStyle: currentPresentation.polygonStyle,
      polylineStyle: currentPresentation.polylineStyle,
      presentedFrames: presentedFrameChannel ?? undefined,
      regionRenderers: resolveRegionRenderers(currentPresentation),
      previewOverlay: options.previewOverlay,
      renderPreparation: options.renderPreparation
        ? {
            ...options.renderPreparation,
            onDiagnostics: handleRenderPreparationDiagnostics,
          }
        : undefined,
      visibility: currentPresentation.visibility,
    });
    publishPlaybackActivity();
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

    if (presentedFrameChannel) {
      // The producer holds the playhead: it decides which frame is on screen
      // and announces it. Pulling samples here would present a second opinion.
      // The producer's playhead is also what keeps the detection buffer hot,
      // through the same coalescing pump the pull path feeds per presented
      // sample. Fire-and-forget by design: awaiting a load anywhere near a draw
      // would gate presentation on it, and a landing for the frame on screen
      // renders through the prepared window's own term. A failed chunk load is
      // retried by the next playhead move.
      transport = createMediaRendererTransport({
        channel: presentedFrameChannel,
        loop: options.loop !== false,
        onPlaybackRate: adoptPlaybackRate,
        onPlaybackState: adoptTransportPlaybackState,
        onScrubbing: (scrubbing) => runtimeState.setScrubbing(scrubbing),
        onSeeking: (seeking) => runtimeState.setSeeking(seeking),
        onPlayheadTime: (currentTime) => {
          runtimeState.recordPlayheadTime(currentTime);
          detectionTimeline?.prefetch(currentTime);
        },
        waitForReadiness: shouldGatePlayback
          ? waitForPlaybackReadiness
          : undefined,
        holdForReadiness: shouldGateDetectionPlayback
          ? holdForDetectionCoverage
          : undefined,
      });
      if (initialPlaybackRate !== 1) {
        transport.setPlaybackRate(initialPlaybackRate);
      }
      detectionTimeline?.prefetch(metadata.firstTimestamp);
      runtimeState.setReady();

      if (options.autoPlay ?? true) {
        await renderer.play();
      }

      return renderer;
    }

    const firstSample = await readFirstDecodedVideoSample({
      sampleSink: mediaSource.sampleSink,
      setActiveIterator(iterator) {
        activeSampleIterator = iterator;
      },
      startTimestamp: metadata.firstTimestamp,
    });

    await prepareAndPresentSample(firstSample);
    runtimeState.setReady();
    const waitForSample = shouldGatePlayback
      ? (sample: DecodedVideoSample) =>
          waitForPlaybackReadiness(sample.timestamp)
      : undefined;

    playbackController = createMediaPlaybackController({
      duration: runtimeState.duration(),
      firstTimestamp: metadata.firstTimestamp,
      initialMediaTime: runtimeState.currentTime(),
      loop: options.loop !== false,
      playbackRate: initialPlaybackRate,
      onCurrentTimeChange(nextCurrentTime) {
        runtimeState.recordPlayheadTime(nextCurrentTime);
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

    // A step lands on a frame, so it closes any drag still open the way a
    // commit does. Left open, the playhead reads as moving while it rests.
    endSeekGesture();

    if (transport) {
      await transport.step(direction === "forward" ? 1 : -1);
      return;
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
      await prepareAndPresentSample(
        sampleToPresent,
        () =>
          requestVersion === navigationVersion && !runtimeState.isDestroyed(),
      );

      if (requestVersion !== navigationVersion || runtimeState.isDestroyed()) {
        return;
      }

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

function resolveRegionRenderers(presentation: MediaRendererPresentation) {
  return (
    presentation.renderers?.filter((renderer) => renderer.kind === "region") ??
    []
  );
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
