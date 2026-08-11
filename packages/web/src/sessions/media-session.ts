import { createMediaRenderer } from "#renderers/media-renderer";
import {
  createDefaultAnnotationPresentation,
  resolveAnnotationRendererPresentation,
  createSourceAwarePresentation,
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
      const directRenderers = resolved.renderers?.filter(
        (renderer) => renderer.kind === "region",
      );
      return {
        ...resolved,
        // Style-backed renderers have already been lowered into their existing
        // specialized fields. Direct renderers retain their descriptors for
        // the browser scene implementation.
        renderers:
          directRenderers && directRenderers.length > 0
            ? directRenderers
            : undefined,
      };
    };
    const initialPresentation =
      resolveRendererPresentation(currentPresentation);

    const renderer = await createMediaRenderer({
      ...options.renderer,
      ...sessionMedia.rendererSourceOption,
      backgroundColor: initialPresentation.backgroundColor,
      annotationOverlayStyle: initialPresentation.annotationOverlayStyle,
      boxStyle: initialPresentation.boxStyle,
      container: options.container,
      detectionBuffer: sessionDefaults.detectionBuffer,
      detectionFrames: sessionDetections.detectionFrames,
      detectionSource: sessionDetections.detectionSource,
      detectionTimelineOrigin: options.detections?.timelineOrigin,
      focusStyle: initialPresentation.focusStyle,
      interactionStyle: initialPresentation.interactionStyle,
      labelStyle: initialPresentation.labelStyle,
      maskStyle: initialPresentation.maskStyle,
      polygonStyle: initialPresentation.polygonStyle,
      polylineStyle: initialPresentation.polylineStyle,
      renderers: initialPresentation.renderers,
      keypointStyle: initialPresentation.keypointStyle,
      visibility: initialPresentation.visibility,
      onState(state) {
        rendererState = state;
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

        return appendableSource.appendFrames(frames);
      },

      async replaceDetectionFrames(frames, writeOptions) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        const appendableSource = resolveAppendableSource(
          sessionDetections,
          writeOptions,
        );

        return appendableSource.replaceFrames(frames);
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
