import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import {
  normalizeMedia,
  normalizeMediaProgressively,
} from "#media/media-normalization";
import { createMediaRenderer } from "#renderers/media-renderer";
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
  MediaSessionOptions,
} from "#types/media-session";
import type {
  MediaRendererOptions,
  MediaRendererPresentation,
  MediaRendererSource,
} from "#types/media-renderer";

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
  const preparedMedia = await prepareSessionMedia(
    options.media,
    options.normalize,
  );
  let preparedDetections: PreparedSessionDetections | undefined;

  try {
    preparedDetections = await prepareSessionDetections(options.detections);
    const sessionDetections = preparedDetections;

    const renderer = await createMediaRenderer({
      ...options.renderer,
      ...preparedMedia.rendererSourceOption,
      boxStyle: options.presentation?.boxStyle ?? undefined,
      container: options.container,
      detectionBuffer: {
        ...options.detections?.buffer,
        playbackGate:
          options.detections?.playbackGate ??
          options.detections?.buffer?.playbackGate,
      },
      detectionFrames: sessionDetections.detectionFrames,
      detectionSource: sessionDetections.detectionSource,
      maskStyle: options.presentation?.maskStyle ?? undefined,
    });
    let destroyed = false;

    return {
      detectionSource: sessionDetections.detectionSource,
      media: preparedMedia.state,
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
        return renderer.getState();
      },

      destroy() {
        if (destroyed) {
          return;
        }

        destroyed = true;
        renderer.destroy();
        preparedMedia.destroy();
      },
    };
  } catch (error) {
    preparedMedia.destroy();
    preparedDetections?.detectionSource?.destroy?.();
    throw error;
  }
}

async function prepareSessionMedia(
  media: MediaSessionMedia,
  normalize: false | MediaSessionNormalizationOptions | undefined,
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

  if (stream) {
    const normalizedMedia = await normalizeMediaProgressively(
      media,
      normalizationOptions,
    );

    void normalizedMedia.completion.catch(() => undefined);

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

  const normalizedMedia = await normalizeMedia(media, normalizationOptions);
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

async function prepareSessionDetections(
  detections: MediaSessionDetectionOptions | undefined,
): Promise<PreparedSessionDetections> {
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
    const writableSource = createWritableDetectionFrameSource({
      chunkDurationSeconds: detections.writable.chunkDurationSeconds,
      datasetId: detections.writable.datasetId,
      store: detections.writable.store,
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
