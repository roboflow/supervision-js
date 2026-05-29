import type {
  AudioCodec,
  Conversion as MediabunnyConversion,
  ConversionAudioOptions,
  ConversionVideoOptions,
  DiscardedTrack,
  VideoCodec,
} from "mediabunny";

import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaProbeIssueCode,
  MediaProbeStatus,
  type MediaNormalizationAudioOptions,
  type MediaNormalizationInputMetadata,
  type MediaNormalizationOptions,
  type MediaNormalizationVideoOptions,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
  type NormalizedMedia,
} from "#types/media-normalization";

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
  type MediaNormalizationProgress,
  type MediaNormalizationVideoOptions,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
  type NormalizedMedia,
} from "#types/media-normalization";

const MIME_TYPES = {
  [MediaNormalizationContainer.Mp4]: "video/mp4",
  [MediaNormalizationContainer.WebM]: "video/webm",
} as const;

const DEFAULT_FRAME_RATE = 30;
const DEFAULT_KEY_FRAME_INTERVAL = 1;
const MEDIA_NORMALIZATION_ABORT_MESSAGE = "Media normalization was aborted.";
const DEFAULT_MEDIA_PROBE_TARGETS: readonly MediaProbeTargetProfile[] = [
  {
    container: MediaNormalizationContainer.WebM,
    frameRate: DEFAULT_FRAME_RATE,
    videoCodec: MediaNormalizationVideoCodec.Vp9,
  },
  {
    container: MediaNormalizationContainer.WebM,
    frameRate: DEFAULT_FRAME_RATE,
    videoCodec: MediaNormalizationVideoCodec.Vp8,
  },
];

export async function probeMedia(
  source: Blob,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> {
  const { ALL_FORMATS, BlobSource, Input, canEncodeVideo } =
    await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });

  try {
    const [canRead, inputMetadata, primaryVideoTrack] = await Promise.all([
      input.canRead(),
      collectInputMetadata(input, source),
      input.getPrimaryVideoTrack(),
    ]);
    const issues: MediaProbeIssue[] = [];

    if (!canRead) {
      issues.push({
        code: MediaProbeIssueCode.InputCannotRead,
        message: "Input media cannot be read by Mediabunny.",
      });
    }

    if (!primaryVideoTrack) {
      issues.push({
        code: MediaProbeIssueCode.PrimaryVideoMissing,
        message: "Input media does not contain a primary video track.",
      });

      return createProbeResult({
        canRead,
        inputMetadata,
        issues,
        primaryVideo: null,
        target: null,
      });
    }

    const primaryVideo = await probePrimaryVideoTrack(primaryVideoTrack);

    if (!primaryVideo.canDecode) {
      issues.push({
        code: MediaProbeIssueCode.PrimaryVideoCannotDecode,
        message: "Primary video track cannot be decoded by this browser.",
      });

      return createProbeResult({
        canRead,
        inputMetadata,
        issues,
        primaryVideo,
        target: null,
      });
    }

    if (issues.length > 0) {
      return createProbeResult({
        canRead,
        inputMetadata,
        issues,
        primaryVideo,
        target: null,
      });
    }

    const target = await selectMediaProbeTarget({
      canEncodeVideo,
      primaryVideo,
      targets: options.targets ?? DEFAULT_MEDIA_PROBE_TARGETS,
    });

    if (!target) {
      issues.push({
        code: MediaProbeIssueCode.TargetVideoCannotEncode,
        message:
          "No requested normalization target can be encoded by this browser.",
      });
    }

    return createProbeResult({
      canRead,
      inputMetadata,
      issues,
      primaryVideo,
      target,
    });
  } finally {
    input.dispose();
  }
}

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

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw createMediaNormalizationAbortError();
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

async function collectInputMetadata(
  input: {
    canRead?(): Promise<boolean>;
    getDurationFromMetadata(
      tracks?: unknown,
      options?: { skipLiveWait?: boolean },
    ): Promise<number | null>;
    getFormat(): Promise<{ mimeType?: string; name?: string }>;
    getMimeType(): Promise<string | null>;
    getPrimaryVideoTrack(): Promise<{
      canDecode?(): Promise<boolean>;
      getCodec?(): Promise<string | null>;
      getDisplayHeight(): Promise<number>;
      getDisplayWidth(): Promise<number>;
    } | null>;
  },
  source: Blob,
): Promise<MediaNormalizationInputMetadata> {
  const [format, detectedMimeType, duration, primaryVideoTrack] =
    await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getPrimaryVideoTrack(),
    ]);

  const [primaryVideoWidth, primaryVideoHeight] = primaryVideoTrack
    ? await Promise.all([
        primaryVideoTrack.getDisplayWidth(),
        primaryVideoTrack.getDisplayHeight(),
      ])
    : [null, null];

  return {
    detectedMimeType,
    duration,
    formatMimeType: format.mimeType ?? null,
    formatName: format.name ?? null,
    primaryVideoHeight,
    primaryVideoWidth,
    sourceMimeType: source.type || null,
  };
}

async function probePrimaryVideoTrack(primaryVideoTrack: {
  canDecode(): Promise<boolean>;
  getCodec(): Promise<string | null>;
  getDisplayHeight(): Promise<number>;
  getDisplayWidth(): Promise<number>;
}): Promise<MediaProbeVideoTrack> {
  const [canDecode, codec, width, height] = await Promise.all([
    primaryVideoTrack.canDecode(),
    primaryVideoTrack.getCodec(),
    primaryVideoTrack.getDisplayWidth(),
    primaryVideoTrack.getDisplayHeight(),
  ]);

  return {
    canDecode,
    codec,
    height,
    width,
  };
}

async function selectMediaProbeTarget(options: {
  readonly canEncodeVideo: (
    codec: VideoCodec,
    options: {
      readonly bitrate?: number;
      readonly height?: number;
      readonly width?: number;
    },
  ) => Promise<boolean>;
  readonly primaryVideo: MediaProbeVideoTrack;
  readonly targets: readonly MediaProbeTargetProfile[];
}) {
  for (const target of options.targets) {
    const canEncode = await options.canEncodeVideo(
      target.videoCodec as VideoCodec,
      {
        ...includeDefined({
          bitrate: target.bitrate,
          height: target.height ?? options.primaryVideo.height,
          width: target.width ?? options.primaryVideo.width,
        }),
      },
    );

    if (canEncode) {
      return {
        ...target,
        frameRate: target.frameRate ?? DEFAULT_FRAME_RATE,
      };
    }
  }

  return null;
}

function createProbeResult(options: {
  readonly canRead: boolean;
  readonly inputMetadata: MediaNormalizationInputMetadata;
  readonly issues: readonly MediaProbeIssue[];
  readonly primaryVideo: MediaProbeVideoTrack | null;
  readonly target: MediaProbeTargetProfile | null;
}): MediaProbeResult {
  return {
    ...options,
    status:
      options.issues.length === 0 && options.target
        ? MediaProbeStatus.Supported
        : MediaProbeStatus.Unsupported,
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

function includeDefined<T extends Record<string, unknown>>(values: T) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
