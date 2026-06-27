import type {
  MediaNormalizationOptions,
  MediaProbeOptions,
  MediaProbeResult,
  NormalizedMedia,
  ProgressiveNormalizedMedia,
} from "#types/media-normalization";

/**
 * Options for probing an uploaded media file and normalizing it to a renderable
 * browser profile.
 */
export interface MediaPreparationOptions {
  /**
   * Probe targets and browser support checks.
   */
  readonly probe?: MediaProbeOptions;
  /**
   * Normalization settings layered on top of the selected probe target.
   */
  readonly normalization?: MediaNormalizationOptions;
}

/**
 * Fully normalized media prepared for URL/blob-based rendering.
 */
export interface PreparedMedia {
  readonly probe: MediaProbeResult;
  readonly normalizedMedia: NormalizedMedia;
}

/**
 * Progressively normalized media prepared for renderer-owned streaming.
 */
export interface ProgressivePreparedMedia {
  readonly probe: MediaProbeResult;
  readonly normalizedMedia: ProgressiveNormalizedMedia;
}
