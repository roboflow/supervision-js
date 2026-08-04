import {
  normalizeMedia,
  normalizeMediaProgressively,
} from "#media/media-normalization";
import type {
  MediaSessionMedia,
  MediaSessionMediaState,
  MediaSessionNormalizationOptions,
} from "#types/media-session";
import type {
  MediaRendererOptions,
  MediaRendererSource,
} from "#types/media-renderer";

export interface PreparedSessionMedia {
  readonly rendererSourceOption: Pick<MediaRendererOptions, "source" | "src">;
  readonly state: MediaSessionMediaState;
  destroy(): void;
}

interface PrepareSessionMediaCallbacks {
  onNormalizationComplete(): void;
  onNormalizationProgress(progress: {
    progress: number;
    processedTime: number;
  }): void;
  onNormalizationStart(): void;
}

export async function prepareSessionMedia(
  media: MediaSessionMedia,
  normalize: false | MediaSessionNormalizationOptions | undefined,
  callbacks: PrepareSessionMediaCallbacks,
): Promise<PreparedSessionMedia> {
  if (typeof media === "string" || isUrl(media) || isRequest(media)) {
    return {
      destroy() {
        // URL sources are owned by the caller.
      },
      rendererSourceOption: { src: media },
      state: createEmptyMediaState(),
    };
  }

  if (isRendererSource(media)) {
    return {
      destroy() {
        // Renderer sources are owned by the caller.
      },
      rendererSourceOption: { source: media },
      state: createEmptyMediaState(),
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

export function createEmptyMediaState(): MediaSessionMediaState {
  return {
    inputMetadata: null,
    normalizedMedia: null,
    objectUrl: null,
  };
}

function isRendererSource(
  media: Exclude<MediaSessionMedia, string | URL | Request>,
): media is MediaRendererSource {
  return typeof (media as MediaRendererSource).open === "function";
}

function isRequest(media: MediaSessionMedia): media is Request {
  return typeof Request === "function" && media instanceof Request;
}

function isUrl(media: MediaSessionMedia): media is URL {
  return typeof URL === "function" && media instanceof URL;
}
