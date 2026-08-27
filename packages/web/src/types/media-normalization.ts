import type { MediaRendererSource } from "#types/media-renderer";

export enum MediaNormalizationContainer {
  WebM = "webm",
  Mp4 = "mp4",
}

export enum MediaNormalizationVideoCodec {
  Vp9 = "vp9",
  Vp8 = "vp8",
  Avc = "avc",
  Av1 = "av1",
}

export enum MediaNormalizationAudioCodec {
  Opus = "opus",
  Aac = "aac",
}

export enum MediaNormalizationFit {
  Fill = "fill",
  Contain = "contain",
  Cover = "cover",
}

export enum MediaProbeStatus {
  Supported = "supported",
  Unsupported = "unsupported",
}

export enum MediaProbeIssueCode {
  InputCannotRead = "inputCannotRead",
  PrimaryVideoMissing = "primaryVideoMissing",
  PrimaryVideoCannotDecode = "primaryVideoCannotDecode",
  TargetVideoCannotEncode = "targetVideoCannotEncode",
}

export interface MediaNormalizationVideoOptions {
  /**
   * Output frame rate in hertz. Defaults to 30, which lands a variable-rate
   * input on a constant grid that detection frame indices can address.
   */
  readonly frameRate?: number;
  /** Output width in pixels. Unset keeps the source's display width. */
  readonly width?: number;
  /** Output height in pixels. Unset keeps the source's display height. */
  readonly height?: number;
  /** How the frame is fitted when both `width` and `height` are set. */
  readonly fit?: MediaNormalizationFit;
  /**
   * Output video codec. Defaults to AVC for `Mp4` and VP9 for `WebM`.
   */
  readonly codec?: MediaNormalizationVideoCodec;
  /** Output bitrate in bits per second. Unset lets the encoder choose. */
  readonly bitrate?: number;
  /**
   * Seconds between key frames. Defaults to 1, which costs bytes and buys the
   * short seeks scrubbing and frame stepping depend on.
   */
  readonly keyFrameInterval?: number;
  /**
   * Always re-encode. Defaults to true, so the output profile is the requested
   * one whatever the input already was; false copies a compatible video stream
   * through untouched.
   */
  readonly forceTranscode?: boolean;
}

export interface MediaNormalizationAudioOptions {
  /** Drop every audio track. Defaults to true. */
  readonly discard?: boolean;
  /** Output audio codec. Unset keeps the container's own default. */
  readonly codec?: MediaNormalizationAudioCodec;
  /** Output bitrate in bits per second. Unset lets the encoder choose. */
  readonly bitrate?: number;
  /** Output sample rate in hertz. Unset keeps the source's. */
  readonly sampleRate?: number;
  /** Output channel count. Unset keeps the source's. */
  readonly numberOfChannels?: number;
  /** Always re-encode audio. Unset leaves that choice to the encoder. */
  readonly forceTranscode?: boolean;
}

export interface MediaNormalizationProgress {
  readonly progress: number;
  readonly processedTime: number;
}

export interface MediaNormalizationOptions {
  /** Output container. Defaults to `WebM`. */
  readonly container?: MediaNormalizationContainer;
  readonly video?: MediaNormalizationVideoOptions;
  readonly audio?: MediaNormalizationAudioOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaNormalizationProgress) => void;
  readonly onOutputProgress?: (
    progress: MediaNormalizationOutputProgress,
  ) => void;
}

export interface MediaNormalizationOutputProgress {
  readonly bytesWritten: number;
}

export interface MediaNormalizationInputMetadata {
  readonly sourceMimeType: string | null;
  readonly detectedMimeType: string | null;
  readonly formatMimeType: string | null;
  readonly formatName: string | null;
  readonly duration: number | null;
  readonly primaryVideoWidth: number | null;
  readonly primaryVideoHeight: number | null;
}

export interface NormalizedMedia {
  readonly blob: Blob;
  readonly container: MediaNormalizationContainer;
  readonly mimeType: string;
  readonly extension: string;
  readonly size: number;
  readonly inputMetadata: MediaNormalizationInputMetadata;
}

export interface ProgressiveNormalizedMedia {
  readonly completion: Promise<NormalizedMedia>;
  readonly container: MediaNormalizationContainer;
  readonly extension: string;
  readonly inputMetadata: MediaNormalizationInputMetadata;
  readonly mimeType: string;
  readonly rendererSource: MediaRendererSource;
  cancel(): Promise<void>;
}

export interface MediaProbeTargetProfile {
  readonly container: MediaNormalizationContainer;
  readonly videoCodec: MediaNormalizationVideoCodec;
  readonly frameRate?: number;
  readonly width?: number;
  readonly height?: number;
  readonly bitrate?: number;
}

export interface MediaProbeVideoTrack {
  readonly canDecode: boolean;
  readonly codec: string | null;
  readonly width: number;
  readonly height: number;
}

export interface MediaProbeIssue {
  readonly code: MediaProbeIssueCode;
  readonly message: string;
}

export interface MediaProbeOptions {
  readonly targets?: readonly MediaProbeTargetProfile[];
}

export interface MediaProbeResult {
  readonly canRead: boolean;
  readonly inputMetadata: MediaNormalizationInputMetadata;
  readonly primaryVideo: MediaProbeVideoTrack | null;
  readonly target: MediaProbeTargetProfile | null;
  readonly issues: readonly MediaProbeIssue[];
  readonly status: MediaProbeStatus;
}
