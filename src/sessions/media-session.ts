import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import {
  normalizeMedia,
  normalizeMediaProgressively,
} from "#media/media-normalization";
import { createMediaRenderer } from "#renderers/media-renderer";
import { DetectionFrameRetentionMode } from "#types/detection-timeline";
import type {
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type {
  MediaSession,
  MediaSessionDetectionOptions,
  MediaSessionMedia,
  MediaSessionMediaState,
  MediaSessionNormalizationOptions,
  MediaSessionNormalizationState,
  MediaSessionOptions,
} from "#types/media-session";
import type {
  MediaRendererOptions,
  MediaRendererPresentation,
  MediaRendererSource,
  MediaRendererState,
} from "#types/media-renderer";
import type { RenderPreparationDiagnostics } from "#types/render-preparation";
import {
  resolveMediaSessionDefaults,
  resolveMediaSessionWritableRetention,
} from "./media-session-defaults";
import { createMediaSessionStateSnapshot } from "./media-session-state";

interface PreparedSessionMedia {
  readonly rendererSourceOption: Pick<MediaRendererOptions, "source" | "src">;
  readonly state: MediaSessionMediaState;
  destroy(): void;
}

interface PreparedSessionDetections {
  readonly detectionFrames?: MediaRendererOptions["detectionFrames"];
  readonly detectionSource?:
    | DetectionFrameSource
    | WritableDetectionFrameSource;
  readonly writableSource?: WritableDetectionFrameSource;
}

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

        if (!sessionDetections.writableSource) {
          throw new Error(
            "This media session does not own a writable detection source.",
          );
        }

        return sessionDetections.writableSource.appendFrames(frames);
      },

      getDetectionSummary() {
        return sessionDetections.writableSource?.getSummary() ?? null;
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

interface PrepareSessionMediaCallbacks {
  onNormalizationComplete(): void;
  onNormalizationProgress(progress: {
    progress: number;
    processedTime: number;
  }): void;
  onNormalizationStart(): void;
}

async function prepareSessionMedia(
  media: MediaSessionMedia,
  normalize: false | MediaSessionNormalizationOptions | undefined,
  callbacks: PrepareSessionMediaCallbacks,
): Promise<PreparedSessionMedia> {
  if (typeof media === "string") {
    return {
      destroy() {
        // URL sources are owned by the caller.
      },
      rendererSourceOption: { src: media },
      state: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
    };
  }

  if (isRendererSource(media)) {
    return {
      destroy() {
        // Renderer sources are owned by the caller.
      },
      rendererSourceOption: { source: media },
      state: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
    };
  }

  if (normalize === false || normalize === undefined) {
    const objectUrl = URL.createObjectURL(media);

    return {
      destroy() {
        URL.revokeObjectURL(objectUrl);
      },
      rendererSourceOption: { src: objectUrl },
      state: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl,
      },
    };
  }

  const { stream, ...normalizationOptions } = normalize;

  callbacks.onNormalizationStart();

  if (stream) {
    const normalizedMedia = await normalizeMediaProgressively(media, {
      ...normalizationOptions,
      onProgress(progress) {
        callbacks.onNormalizationProgress(progress);
        normalizationOptions.onProgress?.(progress);
      },
    });

    void normalizedMedia.completion
      .then(() => {
        callbacks.onNormalizationComplete();
      })
      .catch(() => undefined);

    return {
      destroy() {
        void normalizedMedia.cancel().catch(() => undefined);
      },
      rendererSourceOption: { source: normalizedMedia.rendererSource },
      state: {
        inputMetadata: normalizedMedia.inputMetadata,
        normalizedMedia,
        objectUrl: null,
      },
    };
  }

  const normalizedMedia = await normalizeMedia(media, {
    ...normalizationOptions,
    onProgress(progress) {
      callbacks.onNormalizationProgress(progress);
      normalizationOptions.onProgress?.(progress);
    },
  });
  callbacks.onNormalizationComplete();
  const objectUrl = URL.createObjectURL(normalizedMedia.blob);

  return {
    destroy() {
      URL.revokeObjectURL(objectUrl);
    },
    rendererSourceOption: { src: objectUrl },
    state: {
      inputMetadata: normalizedMedia.inputMetadata,
      normalizedMedia,
      objectUrl,
    },
  };
}

function createEmptyMediaState(): MediaSessionMediaState {
  return {
    inputMetadata: null,
    normalizedMedia: null,
    objectUrl: null,
  };
}

async function prepareSessionDetections(options: {
  readonly detections: MediaSessionDetectionOptions | undefined;
  readonly mode: MediaSessionOptions["mode"];
}): Promise<PreparedSessionDetections> {
  const { detections } = options;

  if (!detections) {
    return {};
  }

  const detectionInputCount = [
    detections.frames !== undefined,
    detections.source !== undefined,
    detections.writable !== undefined,
  ].filter(Boolean).length;

  if (detectionInputCount > 1) {
    throw new Error(
      "Provide only one media session detection input: frames, source, or writable.",
    );
  }

  if (detections.writable) {
    const retention = resolveMediaSessionWritableRetention({
      mode: options.mode,
      writable: detections.writable,
    });
    const store =
      retention.mode === DetectionFrameRetentionMode.MemoryOnly
        ? createMemoryColdDetectionFrameStore()
        : (detections.writable.store ?? createMemoryColdDetectionFrameStore());
    const writableSource = createWritableDetectionFrameSource({
      chunkDurationSeconds: detections.writable.chunkDurationSeconds,
      datasetId: detections.writable.datasetId,
      retention,
      store,
    });

    try {
      if (detections.writable.clearOnCreate) {
        await writableSource.clear();
      }
    } catch (error) {
      writableSource.destroy?.();
      throw error;
    }

    return {
      detectionSource: writableSource,
      writableSource,
    };
  }

  return {
    detectionFrames: detections.frames,
    detectionSource: detections.source,
  };
}

function isRendererSource(
  media: Exclude<MediaSessionMedia, string>,
): media is MediaRendererSource {
  return typeof (media as MediaRendererSource).open === "function";
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
