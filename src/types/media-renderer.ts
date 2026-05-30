import type { BoxStyle } from "#types/box-style";
import type {
  DetectionBufferOptions,
  DetectionBufferState,
  DetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { MaskStyle } from "#types/mask-style";
import type { DecodedMediaSource } from "#media/media-source";
import type { RenderPreparationOptions } from "#types/render-preparation";

export enum MediaRendererFit {
  Contain = "contain",
  Cover = "cover",
}

export enum MediaRendererPlaybackState {
  Loading = "loading",
  Ready = "ready",
  Playing = "playing",
  Buffering = "buffering",
  Paused = "paused",
  Error = "error",
  Destroyed = "destroyed",
}

export enum MediaSourceStatus {
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

export interface MediaFrameDiagnostics {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
}

export interface MediaSourceState {
  readonly status: MediaSourceStatus;
  readonly canRead: boolean | null;
  readonly formatName: string | null;
  readonly formatMimeType: string | null;
  readonly mimeType: string | null;
  readonly duration: number | null;
  readonly trackCount: number | null;
  readonly videoTrackCount: number | null;
  readonly audioTrackCount: number | null;
  readonly primaryVideoWidth: number | null;
  readonly primaryVideoHeight: number | null;
  readonly errorMessage: string | null;
}

export interface MediaRendererState {
  readonly playbackState: MediaRendererPlaybackState;
  readonly fit: MediaRendererFit;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly presentedFrames: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly source: MediaSourceState;
}

export interface MediaRendererOptions {
  readonly container: HTMLElement;
  readonly src?: string;
  readonly source?: MediaRendererSource;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  /**
   * No-op in the current video-only renderer. Audio playback is deferred.
   */
  readonly muted?: boolean;
  readonly fit?: MediaRendererFit;
  readonly detectionFrames?: readonly DetectionFrame[];
  readonly detectionSource?: DetectionFrameSource;
  readonly detectionBuffer?: DetectionBufferOptions;
  readonly boxStyle?: BoxStyle;
  readonly maskStyle?: MaskStyle;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

export interface MediaRendererSource {
  open(): Promise<DecodedMediaSource>;
}

export interface MediaRendererPresentation {
  readonly boxStyle?: BoxStyle | null;
  readonly maskStyle?: MaskStyle | null;
}

export interface MediaRenderer {
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  setPresentation(presentation: MediaRendererPresentation): void;
  getState(): MediaRendererState;
  destroy(): void;
}
