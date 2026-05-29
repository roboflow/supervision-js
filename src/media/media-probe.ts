import type { VideoCodec } from "mediabunny";

import { collectInputMetadata } from "#media/media-metadata";
import {
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaProbeIssueCode,
  MediaProbeStatus,
  type MediaNormalizationInputMetadata,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
} from "#types/media-normalization";
import { includeDefined } from "#utils/object";

const DEFAULT_FRAME_RATE = 30;
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
