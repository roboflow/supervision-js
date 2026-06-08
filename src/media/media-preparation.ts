import {
  normalizeMedia,
  normalizeMediaProgressively,
} from "#media/media-normalization";
import { probeMedia } from "#media/media-probe";
import { MediaProbeStatus } from "#types/media-normalization";
import type {
  MediaPreparationOptions,
  PreparedMedia,
  ProgressivePreparedMedia,
} from "#types/media-preparation";
import type {
  MediaNormalizationOptions,
  MediaNormalizationVideoOptions,
  MediaProbeResult,
  MediaProbeTargetProfile,
} from "#types/media-normalization";

export class MediaPreparationError extends Error {
  readonly probe: MediaProbeResult;

  constructor(probe: MediaProbeResult) {
    super(formatPreparationErrorMessage(probe));
    this.name = "MediaPreparationError";
    this.probe = probe;
  }
}

export async function prepareMedia(
  source: Blob,
  options: MediaPreparationOptions = {},
): Promise<PreparedMedia> {
  const probe = await probeMedia(source, options.probe);

  if (probe.status !== MediaProbeStatus.Supported || !probe.target) {
    throw new MediaPreparationError(probe);
  }

  const normalizedMedia = await normalizeMedia(
    source,
    createNormalizationOptions(options.normalization, probe.target),
  );

  return {
    normalizedMedia,
    probe,
  };
}

export async function prepareMediaProgressively(
  source: Blob,
  options: MediaPreparationOptions = {},
): Promise<ProgressivePreparedMedia> {
  const probe = await probeMedia(source, options.probe);

  if (probe.status !== MediaProbeStatus.Supported || !probe.target) {
    throw new MediaPreparationError(probe);
  }

  const normalizedMedia = await normalizeMediaProgressively(
    source,
    createNormalizationOptions(options.normalization, probe.target),
  );

  return {
    normalizedMedia,
    probe,
  };
}

function createNormalizationOptions(
  options: MediaNormalizationOptions = {},
  target: MediaProbeTargetProfile,
): MediaNormalizationOptions {
  return {
    ...options,
    container: options.container ?? target.container,
    video: createVideoOptions(options.video, target),
  };
}

function createVideoOptions(
  options: MediaNormalizationVideoOptions = {},
  target: MediaProbeTargetProfile,
): MediaNormalizationVideoOptions {
  return {
    ...options,
    bitrate: options.bitrate ?? target.bitrate,
    codec: options.codec ?? target.videoCodec,
    forceTranscode: options.forceTranscode ?? true,
    frameRate: options.frameRate ?? target.frameRate,
    height: options.height ?? target.height,
    width: options.width ?? target.width,
  };
}

function formatPreparationErrorMessage(probe: MediaProbeResult) {
  if (probe.issues.length === 0) {
    return "Media cannot be prepared for rendering.";
  }

  return `Media cannot be prepared for rendering: ${probe.issues
    .map((issue) => issue.message)
    .join(" ")}`;
}
