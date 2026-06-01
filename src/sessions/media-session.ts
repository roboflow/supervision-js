import { createMediaRenderer } from "#renderers/media-renderer";
import type {
  MediaSession,
  MediaSessionMediaState,
  MediaSessionNormalizationState,
  MediaSessionOptions,
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

export async function createMediaSession(
  options: MediaSessionOptions,
): Promise<MediaSession> {
  let rendererState: MediaRendererState | null = null;
  let renderPreparationState: RenderPreparationDiagnostics | null = null;
  let normalizationState: MediaSessionNormalizationState | null = null;
  let sessionErrorMessage: string | null = null;
  let sessionMediaState: MediaSessionMediaState = createEmptyMediaState();
  const emitSessionState = () => {
    options.onState?.(
      createMediaSessionStateSnapshot({
        errorMessage: sessionErrorMessage,
        media: sessionMediaState,
        normalization: normalizationState,
        renderPreparation: renderPreparationState,
        renderer: rendererState,
      }),
    );
  };
  const createSessionState = () =>
    createMediaSessionStateSnapshot({
      errorMessage: sessionErrorMessage,
      media: sessionMediaState,
      normalization: normalizationState,
      renderPreparation: renderPreparationState,
      renderer: rendererState,
    });

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

    const renderer = await createMediaRenderer({
      ...options.renderer,
      ...sessionMedia.rendererSourceOption,
      boxStyle: options.presentation?.boxStyle ?? undefined,
      container: options.container,
      detectionBuffer: sessionDefaults.detectionBuffer,
      detectionFrames: sessionDetections.detectionFrames,
      detectionSource: sessionDetections.detectionSource,
      labelStyle: options.presentation?.labelStyle ?? undefined,
      maskStyle: options.presentation?.maskStyle ?? undefined,
      onState(state) {
        rendererState = state;
        options.renderer?.onState?.(state);
        emitSessionState();
      },
      renderPreparation: {
        ...sessionDefaults.renderPreparation,
        onDiagnostics(diagnostics) {
          renderPreparationState = diagnostics;
          options.renderer?.renderPreparation?.onDiagnostics?.(diagnostics);
          emitSessionState();
        },
      },
    });
    rendererState = renderer.getState();
    emitSessionState();
    let destroyed = false;

    return {
      detectionSource: sessionDetections.detectionSource,
      media: sessionMedia.state,
      renderer,

      appendDetectionFrames(frames) {
        if (destroyed) {
          throw new Error("Media session has been destroyed.");
        }

        if (!sessionDetections.appendableSource) {
          throw new Error(
            "This media session does not own an appendable detection source.",
          );
        }

        return sessionDetections.appendableSource.appendFrames(frames);
      },

      getDetectionSummary() {
        return sessionDetections.appendableSource?.getSummary() ?? null;
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

      setPresentation(presentation: MediaRendererPresentation) {
        renderer.setPresentation(presentation);
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
        renderer.destroy();
        rendererState = renderer.getState();
        sessionMedia.destroy();
        emitSessionState();
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
