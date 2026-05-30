import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionBufferOptions,
  DetectionPlaybackGateOptions,
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type {
  MediaNormalizationInputMetadata,
  MediaNormalizationProgress,
  MediaNormalizationOptions,
  NormalizedMedia,
  ProgressiveNormalizedMedia,
} from "#types/media-normalization";
import type {
  MediaFrameDiagnostics,
  MediaRenderer,
  MediaRendererFit,
  MediaRendererPresentation,
  MediaRendererOptions,
  MediaRendererSource,
  MediaRendererState,
  MediaSourceState,
} from "#types/media-renderer";
import type {
  RenderPreparationArtifactKind,
  RenderPreparationDiagnostics,
} from "#types/render-preparation";

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
  readonly playbackGate?: DetectionPlaybackGateOptions;
}

export interface MediaSessionRendererOptions {
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  readonly fit?: MediaRendererFit;
  readonly renderPreparation?: MediaRendererOptions["renderPreparation"];
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

export interface MediaSessionOptions {
  readonly container: HTMLElement;
  readonly media: MediaSessionMedia;
  readonly normalize?: false | MediaSessionNormalizationOptions;
  readonly detections?: MediaSessionDetectionOptions;
  readonly onState?: (state: MediaSessionState) => void;
  readonly presentation?: MediaRendererPresentation;
  readonly renderer?: MediaSessionRendererOptions;
}

export interface MediaSessionMediaState {
  readonly inputMetadata: MediaNormalizationInputMetadata | null;
  readonly normalizedMedia: NormalizedMedia | ProgressiveNormalizedMedia | null;
  readonly objectUrl: string | null;
}

export enum MediaSessionStatus {
  Buffering = "buffering",
  Destroyed = "destroyed",
  Error = "error",
  Loading = "loading",
  Paused = "paused",
  Playing = "playing",
  Processing = "processing",
  Ready = "ready",
}

export enum MediaSessionActivityKind {
  DetectionsBuffering = "detectionsBuffering",
  DetectionsLoading = "detectionsLoading",
  Error = "error",
  MediaNormalizing = "mediaNormalizing",
  MediaOpening = "mediaOpening",
  PlaybackBuffering = "playbackBuffering",
  RenderPreparing = "renderPreparing",
}

export enum MediaSessionActivityStatus {
  Error = "error",
  Running = "running",
  Waiting = "waiting",
}

export interface MediaSessionActivity {
  readonly artifactKind?: RenderPreparationArtifactKind;
  readonly blockingPlayback?: boolean;
  readonly blockingPresentation?: boolean;
  readonly detail?: string | null;
  readonly errorMessage?: string | null;
  readonly kind: MediaSessionActivityKind;
  readonly label: string;
  readonly pendingCount?: number;
  readonly preparedCount?: number;
  readonly progress?: number;
  readonly status: MediaSessionActivityStatus;
}

export interface MediaSessionNormalizationState {
  readonly active: boolean;
  readonly progress: MediaNormalizationProgress | null;
}

export interface MediaSessionState {
  readonly activities: readonly MediaSessionActivity[];
  readonly errorMessage: string | null;
  readonly media: MediaSessionMediaState;
  readonly normalization: MediaSessionNormalizationState | null;
  readonly renderPreparation: RenderPreparationDiagnostics | null;
  readonly renderer: MediaRendererState | null;
  readonly status: MediaSessionStatus;
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
  getState(): MediaSessionState;
  destroy(): void;
}
