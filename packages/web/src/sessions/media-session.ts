import { createMediaRenderer } from "#renderers/media-renderer";
import {
  createDefaultAnnotationPresentation,
  projectDetectionFrames,
  resolveAnnotationRendererPresentation,
  createSourceAwarePresentation,
} from "supervision-js-core";
import type {
  DetectionCoordinateSpace,
  DetectionFrame,
  DetectionFrameSourceVersionRange,
  LiveWritableDetectionFrameSource,
  WritableDetectionFrameSource,
} from "supervision-js-core";
import type {
  MediaSession,
  MediaSessionDetectionWriteOptions,
  MediaSessionMediaState,
  MediaSessionNormalizationState,
  MediaSessionOptions,
  MediaSessionStateListener,
} from "#types/media-session";
import type {
  MediaRendererPresentation,
  MediaRendererState,
} from "#types/media-renderer";
import type { RenderPreparationDiagnostics } from "#types/render-preparation";
import {
  prepareSessionDetections,
  type PreparedSessionDetections,
} from "./media-session-detections";
import { resolveMediaSessionDefaults } from "./media-session-defaults";
import {
  createEmptyMediaState,
  prepareSessionMedia,
  type PreparedSessionMedia,
} from "./media-session-media";
import { createMediaSessionStateSnapshot } from "./media-session-state";

const DISPLAY_RANGE_EPSILON_SECONDS = 1e-6;

/**
 * Creates a renderer-owned media session for one browser media item.
 *
 * Start with `container` and `media` for the default playback/rendering path.
 * Add detections, presentation styles, interaction, normalization, or buffering
 * options only when the host application needs them.
 */
export async function createMediaSession(
  options: MediaSessionOptions,
): Promise<MediaSession> {
  const stateListeners = new Set<MediaSessionStateListener>();
  let rendererState: MediaRendererState | null = null;
  let renderPreparationState: RenderPreparationDiagnostics | null = null;
  let normalizationState: MediaSessionNormalizationState | null = null;
  let sessionErrorMessage: string | null = null;
  let sessionMediaState: MediaSessionMediaState = createEmptyMediaState();
  let destroyed = false;
  let isDestroying = false;
  const createSessionState = () =>
    createMediaSessionStateSnapshot({
      errorMessage: sessionErrorMessage,
      media: sessionMediaState,
      normalization: normalizationState,
      renderPreparation: renderPreparationState,
      renderer: rendererState,
    });
  const emitSessionState = () => {
    const state = createSessionState();

    for (const listener of stateListeners) {
      listener(state);
    }
  };

  if (options.onState) {
    stateListeners.add(options.onState);
  }

  emitSessionState();

  let preparedMedia: PreparedSessionMedia | undefined;
  let preparedDetections: PreparedSessionDetections | undefined;

  try {
    preparedMedia = await prepareSessionMedia(
      options.media,
      options.normalize,
      {
        onNormalizationComplete() {
          normalizationState = normalizationState
            ? { ...normalizationState, active: false }
            : null;
          emitSessionState();
        },
        onNormalizationProgress(progress) {
          normalizationState = { active: true, progress };
          emitSessionState();
        },
        onNormalizationStart() {
          normalizationState = { active: true, progress: null };
          emitSessionState();
        },
      },
    );
    sessionMediaState = preparedMedia.state;
    emitSessionState();
    const sessionMedia = preparedMedia;
    const sessionDefaults = resolveMediaSessionDefaults({
      detections: options.detections,
      mode: options.mode,
      renderer: options.renderer,
    });

    preparedDetections = await prepareSessionDetections({
      detections: options.detections,
      mode: options.mode,
    });
    const sessionDetections = preparedDetections;
    const defaultPresentation = createDefaultAnnotationPresentation();
    let currentPresentation = options.presentation;
    const resolvePresentation = (
      presentation: MediaRendererPresentation | undefined,
    ) => {
      const renderers = presentation?.renderers;
      const resolvedPresentation = resolveAnnotationRendererPresentation({
        ...defaultPresentation,
        ...presentation,
      });

      return createSourceAwarePresentation<MediaRendererPresentation>(
        resolvedPresentation,
        sessionDetections.sourcePresentations,
        renderers === undefined
          ? undefined
          : { enabledRendererKinds: renderers.map(({ kind }) => kind) },
      );
    };
    const resolveRendererPresentation = (
      presentation: MediaRendererPresentation | undefined,
    ): MediaRendererPresentation => {
      const resolved = resolvePresentation(presentation);

      return {
        ...resolved,
        // Style-backed renderers have already been lowered into their
        // specialized fields, including source overrides. Keep their kinds in
        // the authoritative list so the renderer core does not clear those
        // fields when direct renderers are also present, but let the resolved
        // fields win over the descriptors' original global styles.
        renderers: resolved.renderers?.map((renderer) =>
          renderer.kind === "region"
            ? renderer
            : { ...renderer, style: undefined },
        ),
      };
    };
    const initialPresentation =
      resolveRendererPresentation(currentPresentation);
    let mediaCoordinateSpace: DetectionCoordinateSpace | null = null;

    /**
     * Latches the media coordinate space as soon as the renderer reports real
     * media dimensions, so session writes can be normalized into it.
     */
    const recordMediaCoordinateSpace = (state: MediaRendererState) => {
      if (state.mediaWidth > 0 && state.mediaHeight > 0) {
        mediaCoordinateSpace = {
          height: state.mediaHeight,
          width: state.mediaWidth,
        };
      }
    };

    const renderer = await createMediaRenderer({
      ...options.renderer,
      ...sessionMedia.rendererSourceOption,
      backgroundColor: initialPresentation.backgroundColor,
      annotationOverlayStyle: initialPresentation.annotationOverlayStyle,
      boxStyle: initialPresentation.boxStyle,
      boxCornerStyle: initialPresentation.boxCornerStyle,
      ellipseStyle: initialPresentation.ellipseStyle,
      container: options.container,
      detectionBuffer: sessionDefaults.detectionBuffer,
      detectionFrames: sessionDetections.detectionFrames,
      detectionSource: sessionDetections.detectionSource,
      detectionTimelineOrigin: options.detections?.timelineOrigin,
      focusStyle: initialPresentation.focusStyle,
      interactionStyle: initialPresentation.interactionStyle,
      labelStyle: initialPresentation.labelStyle,
      maskHaloStyle: initialPresentation.maskHaloStyle,
      maskStyle: initialPresentation.maskStyle,
      markerStyle: initialPresentation.markerStyle,
      polygonStyle: initialPresentation.polygonStyle,
      polylineStyle: initialPresentation.polylineStyle,
      renderers: initialPresentation.renderers,
      keypointStyle: initialPresentation.keypointStyle,
      visibility: initialPresentation.visibility,
      onState(state) {
        rendererState = state;
        recordMediaCoordinateSpace(state);
        options.renderer?.onState?.(state);
        if (isDestroying) {
          return;
        }

        emitSessionState();
      },
      renderPreparation: {
        ...sessionDefaults.renderPreparation,
        onDiagnostics(diagnostics) {
          renderPreparationState = diagnostics;
          options.renderer?.renderPreparation?.onDiagnostics?.(diagnostics);
          if (isDestroying) {
            return;
          }

          emitSessionState();
        },
      },
    });
    rendererState = renderer.getState();
    emitSessionState();

    const autoRefresh = options.detections?.autoRefresh !== false;
    let activeRefresh: Promise<void> | undefined;
    let queuedRefresh = false;

    const runDetectionRefresh = () => {
      activeRefresh = renderer
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          activeRefresh = undefined;

          if (queuedRefresh && !destroyed) {
            queuedRefresh = false;
            runDetectionRefresh();
          }
        });
    };

    /**
     * Redraws once, collapsing requests that arrive during a redraw into a
     * single follow-up.
     */
    const scheduleDetectionRefresh = () => {
      if (!autoRefresh || destroyed) {
        return;
      }

      if (activeRefresh) {
        queuedRefresh = true;
        return;
      }

      runDetectionRefresh();
    };

    /**
     * Normalizes written frames into media space before they are stored, so a
     * persisted dataset stays in one coordinate space. The renderer projects
     * again on the read path for every other detection input, and re-projecting
     * an already-projected frame is a no-op.
     */
    const projectWrittenFrames = (frames: readonly DetectionFrame[]) =>
      mediaCoordinateSpace
        ? projectDetectionFrames(frames, mediaCoordinateSpace)
        : frames;

    /**
     * Redraws once for a write that actually changed `range`.
     *
     * A write the source rejected as stale reports no change at all, and
     * changes elsewhere on the timeline are already patched incrementally by
     * the hot buffer, so forcing a render for either would only burn frames.
     */
    const requestDetectionRefresh = (
      source: WritableDetectionFrameSource,
      previousVersion: number,
      range: DetectionFrameSourceVersionRange,
    ) => {
      const changes = source.getChangesSince?.(previousVersion, [range]);

      if (!changes || changes.requiresReload || changes.ranges.length > 0) {
        scheduleDetectionRefresh();
      }
    };

    /** The instant the renderer is currently presenting. */
    const getDisplayedRange = (): DetectionFrameSourceVersionRange => {
      const { currentTime } = renderer.getState();

      return {
        endTime: currentTime + DISPLAY_RANGE_EPSILON_SECONDS,
        startTime: currentTime - DISPLAY_RANGE_EPSILON_SECONDS,
      };
    };

    return {
      detectionSource: sessionDetections.detectionSource,
      media: sessionMedia.state,
      renderer,

      async appendDetectionFrames(frames, writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );
        const previousVersion = appendableSource.getVersion();
        const summary = await appendableSource.appendFrames(
          projectWrittenFrames(frames),
        );

        requestDetectionRefresh(
          appendableSource,
          previousVersion,
          getDisplayedRange(),
        );

        return summary;
      },

      async appendLiveDetectionFrame(frame, writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );
        const previousVersion = appendableSource.getVersion();
        const [projectedFrame = frame] = projectWrittenFrames([frame]);
        const summary =
          await requireLiveDetectionSource(appendableSource).appendLiveFrame(
            projectedFrame,
          );

        // Live writes are gated on the displayed instant like any other write.
        // A result the source dropped as stale changes nothing, and one whose
        // interval does not contain the displayed time cannot alter the frame
        // currently selected for it.
        requestDetectionRefresh(
          appendableSource,
          previousVersion,
          getDisplayedRange(),
        );

        return summary;
      },

      async finalizeDetectionCoverage(endTime, writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );
        const coverageEndTime = endTime ?? renderer.getState().duration;

        if (coverageEndTime === null) {
          return null;
        }

        return requireLiveDetectionSource(appendableSource).finalizeCoverage(
          coverageEndTime,
        );
      },

      async replaceDetectionFrames(frames, writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );
        const previousVersion = appendableSource.getVersion();
        const summary = await appendableSource.replaceFrames(
          projectWrittenFrames(frames),
        );

        requestDetectionRefresh(
          appendableSource,
          previousVersion,
          getDisplayedRange(),
        );

        return summary;
      },

      async clearDetectionFrames(writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );

        await appendableSource.clear();
      },

      getDetectionSummary(writeOptions) {
        return (
          resolveAppendableSourceOrNull(
            sessionDetections,
            writeOptions,
          )?.getSummary() ?? null
        );
      },

      play() {
        return renderer.play();
      },

      pause() {
        renderer.pause();
      },

      seek(mediaTime) {
        return renderer.seek(mediaTime);
      },

      stepForward() {
        return renderer.stepForward();
      },

      stepBackward() {
        return renderer.stepBackward();
      },

      setPlaybackRate(playbackRate) {
        renderer.setPlaybackRate(playbackRate);
      },

      refresh() {
        return renderer.refresh();
      },

      captureFrame(captureOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        return renderer.captureFrame(captureOptions);
      },

      setPresentation(presentation: MediaRendererPresentation) {
        currentPresentation = presentation;
        renderer.setPresentation(
          resolveRendererPresentation(currentPresentation),
        );
      },

      setRenderQuality(quality) {
        renderer.setRenderQuality(quality);
        rendererState = renderer.getState();
        emitSessionState();
      },

      subscribe(listener) {
        listener(createSessionState());

        if (destroyed) {
          return () => undefined;
        }

        stateListeners.add(listener);

        return () => {
          stateListeners.delete(listener);
        };
      },

      getState() {
        rendererState = renderer.getState();
        return createSessionState();
      },

      destroy() {
        if (destroyed) {
          return;
        }

        destroyed = true;
        isDestroying = true;
        renderer.destroy();
        rendererState = renderer.getState();
        sessionMedia.destroy();
        isDestroying = false;
        emitSessionState();
        stateListeners.clear();
      },
    };
  } catch (error) {
    sessionErrorMessage = getErrorMessage(
      error,
      "Unable to create media session.",
    );
    emitSessionState();
    preparedMedia?.destroy();
    preparedDetections?.detectionSource?.destroy?.();
    throw error;
  }
}

function resolveAppendableSource(
  sessionDetections: PreparedSessionDetections,
  options: MediaSessionDetectionWriteOptions | undefined,
) {
  const appendableSource = resolveAppendableSourceOrNull(
    sessionDetections,
    options,
  );

  if (!appendableSource) {
    throw new Error(
      "This media session does not own an appendable detection source.",
    );
  }

  return appendableSource;
}

function resolveAppendableSourceOrNull(
  sessionDetections: PreparedSessionDetections,
  options: MediaSessionDetectionWriteOptions | undefined,
) {
  if (options?.sourceId) {
    const appendableSource =
      sessionDetections.appendableSources.get(options.sourceId) ??
      (sessionDetections.appendableSource?.datasetId === options.sourceId
        ? sessionDetections.appendableSource
        : undefined);

    if (!appendableSource) {
      throw new Error(
        `Unknown appendable detection source: ${options.sourceId}.`,
      );
    }

    return appendableSource;
  }

  if (sessionDetections.appendableSources.size > 1) {
    throw new Error(
      "sourceId is required when a media session owns multiple appendable detection sources.",
    );
  }

  return (
    sessionDetections.appendableSource ??
    sessionDetections.appendableSources.values().next().value ??
    null
  );
}

/**
 * Narrows an appendable source to the live ingestion capability.
 *
 * Live appends and coverage finalization are optional on
 * `WritableDetectionFrameSource` so implementations written before they existed
 * stay assignable. Such a source fails here with a clear message rather than a
 * `TypeError` at the call site.
 */
function requireLiveDetectionSource(
  source: WritableDetectionFrameSource,
): LiveWritableDetectionFrameSource {
  if (!source.appendLiveFrame || !source.finalizeCoverage) {
    throw new Error(
      "This detection source does not support live appends or coverage finalization.",
    );
  }

  return source as LiveWritableDetectionFrameSource;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
