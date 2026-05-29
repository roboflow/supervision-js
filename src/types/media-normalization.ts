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
  readonly frameRate?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: MediaNormalizationFit;
  readonly codec?: MediaNormalizationVideoCodec;
  readonly bitrate?: number;
  readonly keyFrameInterval?: number;
  readonly forceTranscode?: boolean;
}

export interface MediaNormalizationAudioOptions {
  readonly discard?: boolean;
  readonly codec?: MediaNormalizationAudioCodec;
  readonly bitrate?: number;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  readonly forceTranscode?: boolean;
}

export interface MediaNormalizationProgress {
  readonly progress: number;
  readonly processedTime: number;
}

export interface MediaNormalizationOptions {
  readonly container?: MediaNormalizationContainer;
  readonly video?: MediaNormalizationVideoOptions;
  readonly audio?: MediaNormalizationAudioOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaNormalizationProgress) => void;
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
