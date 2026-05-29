import type {
  MediaNormalizationOptions,
  MediaProbeOptions,
  MediaProbeResult,
  NormalizedMedia,
} from "#types/media-normalization";

export interface MediaPreparationOptions {
  readonly probe?: MediaProbeOptions;
  readonly normalization?: MediaNormalizationOptions;
}

export interface PreparedMedia {
  readonly probe: MediaProbeResult;
  readonly normalizedMedia: NormalizedMedia;
}
