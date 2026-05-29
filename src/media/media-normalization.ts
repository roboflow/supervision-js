import type {
  AudioCodec,
  Conversion as MediabunnyConversion,
  ConversionAudioOptions,
  ConversionVideoOptions,
  DiscardedTrack,
  VideoCodec,
} from "mediabunny";

import { collectInputMetadata } from "#media/media-metadata";
import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  type MediaNormalizationAudioOptions,
  type MediaNormalizationInputMetadata,
  type MediaNormalizationOptions,
  type MediaNormalizationVideoOptions,
  type NormalizedMedia,
  type ProgressiveNormalizedMedia,
} from "#types/media-normalization";
import { createMediabunnyMediaRendererSource } from "#media/mediabunny-media-source";
import { includeDefined } from "#utils/object";

export {
  MediaNormalizationAudioCodec,
  MediaNormalizationContainer,
  MediaNormalizationFit,
  MediaNormalizationVideoCodec,
  MediaProbeIssueCode,
  MediaProbeStatus,
  type MediaNormalizationAudioOptions,
  type MediaNormalizationInputMetadata,
  type MediaNormalizationOptions,
  type MediaNormalizationOutputProgress,
  type MediaNormalizationProgress,
  type MediaNormalizationVideoOptions,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
  type NormalizedMedia,
  type ProgressiveNormalizedMedia,
} from "#types/media-normalization";
export { probeMedia } from "#media/media-probe";

const MIME_TYPES = {
  [MediaNormalizationContainer.Mp4]: "video/mp4",
  [MediaNormalizationContainer.WebM]: "video/webm",
} as const;

const DEFAULT_FRAME_RATE = 30;
const DEFAULT_KEY_FRAME_INTERVAL = 1;
const MEDIA_NORMALIZATION_ABORT_MESSAGE = "Media normalization was aborted.";

export async function normalizeMedia(
  source: Blob,
  options: MediaNormalizationOptions = {},
): Promise<NormalizedMedia> {
  throwIfAborted(options.signal);

  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
  } = await import("mediabunny");

  const container = options.container ?? MediaNormalizationContainer.WebM;
  const target = new BufferTarget();
  const output = new Output({
    format:
      container === MediaNormalizationContainer.Mp4
        ? new Mp4OutputFormat()
        : new WebMOutputFormat(),
    target,
  });
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });
  let conversion: MediabunnyConversion | undefined;
  let abortConversion: (() => void) | undefined;

  try {
    const inputMetadata = await collectInputMetadata(input, source);
    throwIfAborted(options.signal);

    conversion = await Conversion.init({
      audio: buildAudioOptions(options.audio),
      input,
      output,
      showWarnings: false,
      tracks: "primary",
      video: buildVideoOptions(container, options.video),
    });

    if (options.signal) {
      abortConversion = () => {
        void conversion?.cancel().catch(() => undefined);
      };
      options.signal.addEventListener("abort", abortConversion);
      if (options.signal.aborted) {
        abortConversion();
        throw createMediaNormalizationAbortError();
      }
    }

    if (!conversion.isValid) {
      throw new Error(
        `Mediabunny conversion is invalid: ${formatDiscardedTracks(
          conversion.discardedTracks,
        )}.`,
      );
    }

    conversion.onProgress = (progress, processedTime) => {
      options.onProgress?.({ processedTime, progress });
    };

    try {
      await conversion.execute();
    } catch (error: unknown) {
      if (isConversionAbortError(error, options.signal)) {
        throw createMediaNormalizationAbortError();
      }

      throw error;
    }

    if (!target.buffer) {
      throw new Error("Mediabunny conversion completed without output data.");
    }

    const mimeType = MIME_TYPES[container];
    const blob = new Blob([target.buffer], { type: mimeType });

    return {
      blob,
      container,
      extension: container,
      inputMetadata,
      mimeType,
      size: blob.size,
    };
  } finally {
    if (options.signal && abortConversion) {
      options.signal.removeEventListener("abort", abortConversion);
    }
    input.dispose();
  }
}

export async function normalizeMediaProgressively(
  source: Blob,
  options: MediaNormalizationOptions = {},
): Promise<ProgressiveNormalizedMedia> {
  throwIfAborted(options.signal);

  const {
    ALL_FORMATS,
    AppendOnlyStreamTarget,
    BlobSource,
    Conversion,
    Input,
    Output,
    ReadableStreamSource,
    WEBM,
    WebMOutputFormat,
  } = await import("mediabunny");

  const container = options.container ?? MediaNormalizationContainer.WebM;

  if (container !== MediaNormalizationContainer.WebM) {
    throw new Error("Progressive media normalization currently requires WebM.");
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });
  let conversion: MediabunnyConversion | undefined;
  let abortConversion: (() => void) | undefined;
  const outputStream = new TransformStream<Uint8Array, Uint8Array>();
  const rendererReadable = outputStream.readable;
  const outputWriter = outputStream.writable.getWriter();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytesWritten = 0;

  try {
    const inputMetadata = await collectInputMetadata(input, source);
    throwIfAborted(options.signal);

    const target = new AppendOnlyStreamTarget(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          const stableChunk = new Uint8Array(chunk);

          chunks.push(stableChunk);
          bytesWritten += stableChunk.byteLength;
          options.onOutputProgress?.({ bytesWritten });
          await outputWriter.write(stableChunk);
        },
        async close() {
          await outputWriter.close();
        },
        async abort(error) {
          await outputWriter.abort(error);
        },
      }),
    );
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    });

    conversion = await Conversion.init({
      audio: buildAudioOptions(options.audio),
      input,
      output,
      showWarnings: false,
      tracks: "primary",
      video: buildVideoOptions(container, options.video),
    });

    if (!conversion.isValid) {
      throw new Error(
        `Mediabunny conversion is invalid: ${formatDiscardedTracks(
          conversion.discardedTracks,
        )}.`,
      );
    }

    if (options.signal) {
      abortConversion = () => {
        void conversion?.cancel().catch(() => undefined);
      };
      options.signal.addEventListener("abort", abortConversion);
      if (options.signal.aborted) {
        abortConversion();
        throw createMediaNormalizationAbortError();
      }
    }

    conversion.onProgress = (progress, processedTime) => {
      options.onProgress?.({ processedTime, progress });
    };

    const progressiveConversion = conversion;
    const mimeType = MIME_TYPES[container];
    const completion = executeProgressiveConversion({
      chunks,
      container,
      conversion: progressiveConversion,
      input,
      inputMetadata,
      mimeType,
      outputWriter,
      removeAbortListener() {
        if (options.signal && abortConversion) {
          options.signal.removeEventListener("abort", abortConversion);
        }
      },
      signal: options.signal,
    });

    return {
      cancel() {
        return progressiveConversion.cancel();
      },
      completion,
      container,
      extension: container,
      inputMetadata,
      mimeType,
      rendererSource: createMediabunnyMediaRendererSource({
        formats: [WEBM],
        source: new ReadableStreamSource(rendererReadable, {
          maxCacheSize: 512 * 2 ** 20,
        }),
      }),
    };
  } catch (error) {
    if (options.signal && abortConversion) {
      options.signal.removeEventListener("abort", abortConversion);
    }
    input.dispose();
    try {
      await outputWriter.abort(error);
    } catch {
      // The stream may already be closed if setup failed late.
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw createMediaNormalizationAbortError();
  }
}

async function executeProgressiveConversion(options: {
  readonly chunks: readonly Uint8Array<ArrayBuffer>[];
  readonly container: MediaNormalizationContainer;
  readonly conversion: MediabunnyConversion;
  readonly input: { dispose(): void };
  readonly inputMetadata: MediaNormalizationInputMetadata;
  readonly mimeType: string;
  readonly outputWriter: WritableStreamDefaultWriter<Uint8Array>;
  readonly removeAbortListener: () => void;
  readonly signal?: AbortSignal;
}): Promise<NormalizedMedia> {
  try {
    try {
      await options.conversion.execute();
    } catch (error: unknown) {
      await abortProgressiveOutput(options.outputWriter, error);

      if (isConversionAbortError(error, options.signal)) {
        throw createMediaNormalizationAbortError();
      }

      throw error;
    }

    const blob = new Blob([...options.chunks], { type: options.mimeType });

    return {
      blob,
      container: options.container,
      extension: options.container,
      inputMetadata: options.inputMetadata,
      mimeType: options.mimeType,
      size: blob.size,
    };
  } finally {
    options.removeAbortListener();
    options.input.dispose();
  }
}

async function abortProgressiveOutput(
  outputWriter: WritableStreamDefaultWriter<Uint8Array>,
  error: unknown,
) {
  try {
    await outputWriter.abort(error);
  } catch {
    // The target may have already closed or aborted the stream.
  }
}

function createMediaNormalizationAbortError() {
  return new Error(MEDIA_NORMALIZATION_ABORT_MESSAGE);
}

function isConversionAbortError(
  error: unknown,
  signal: AbortSignal | undefined,
) {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "ConversionCanceledError")
  );
}

function buildVideoOptions(
  container: MediaNormalizationContainer,
  options: MediaNormalizationVideoOptions = {},
): ConversionVideoOptions {
  return {
    ...includeDefined({
      bitrate: options.bitrate,
      fit: options.fit,
      height: options.height,
      width: options.width,
    }),
    codec: (options.codec ??
      (container === MediaNormalizationContainer.Mp4
        ? MediaNormalizationVideoCodec.Avc
        : MediaNormalizationVideoCodec.Vp9)) as VideoCodec,
    forceTranscode: options.forceTranscode ?? true,
    frameRate: options.frameRate ?? DEFAULT_FRAME_RATE,
    keyFrameInterval: options.keyFrameInterval ?? DEFAULT_KEY_FRAME_INTERVAL,
  };
}

function buildAudioOptions(
  options: MediaNormalizationAudioOptions = {},
): ConversionAudioOptions {
  return {
    ...includeDefined({
      bitrate: options.bitrate,
      codec: options.codec as AudioCodec | undefined,
      numberOfChannels: options.numberOfChannels,
      sampleRate: options.sampleRate,
    }),
    discard: options.discard ?? true,
    ...(options.forceTranscode === undefined
      ? {}
      : { forceTranscode: options.forceTranscode }),
  };
}

function formatDiscardedTracks(discardedTracks: readonly DiscardedTrack[]) {
  if (discardedTracks.length === 0) {
    return "no usable tracks were found";
  }

  return `discarded tracks: ${discardedTracks
    .map((discardedTrack) => {
      return `${discardedTrack.track.type} (${discardedTrack.reason})`;
    })
    .join(", ")}`;
}
