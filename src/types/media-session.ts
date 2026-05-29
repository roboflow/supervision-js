import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionBufferOptions,
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type {
  MediaNormalizationInputMetadata,
  MediaNormalizationOptions,
  NormalizedMedia,
  ProgressiveNormalizedMedia,
} from "#types/media-normalization";
import type {
  MediaFrameDiagnostics,
  MediaRenderer,
  MediaRendererFit,
  MediaRendererPresentation,
  MediaRendererSource,
  MediaRendererState,
  MediaSourceState,
} from "#types/media-renderer";

export type MediaSessionMedia = string | Blob | MediaRendererSource;

export interface MediaSessionNormalizationOptions extends MediaNormalizationOptions {
  readonly stream?: boolean;
}

export interface MediaSessionWritableDetectionOptions {
  readonly store: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
  readonly clearOnCreate?: boolean;
}

export interface MediaSessionDetectionOptions {
  readonly frames?: readonly DetectionFrame[];
  readonly source?: DetectionFrameSource;
  readonly writable?: MediaSessionWritableDetectionOptions;
  readonly buffer?: DetectionBufferOptions;
}

export interface MediaSessionRendererOptions {
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  readonly fit?: MediaRendererFit;
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
}

export interface MediaSessionOptions {
  readonly container: HTMLElement;
  readonly media: MediaSessionMedia;
  readonly normalize?: false | MediaSessionNormalizationOptions;
  readonly detections?: MediaSessionDetectionOptions;
  readonly presentation?: MediaRendererPresentation;
  readonly renderer?: MediaSessionRendererOptions;
}

export interface MediaSessionMediaState {
  readonly inputMetadata: MediaNormalizationInputMetadata | null;
  readonly normalizedMedia: NormalizedMedia | ProgressiveNormalizedMedia | null;
  readonly objectUrl: string | null;
}

export interface MediaSession {
  readonly detectionSource?:
    | DetectionFrameSource
    | WritableDetectionFrameSource;
  readonly media: MediaSessionMediaState;
  readonly renderer: MediaRenderer;
  appendDetectionFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  getDetectionSummary(): ColdDetectionFrameStoreWriteSummary | null;
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  setPresentation(presentation: MediaRendererPresentation): void;
  getState(): MediaRendererState;
  destroy(): void;
}
