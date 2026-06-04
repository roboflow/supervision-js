import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionBufferOptions,
  DetectionFrameRetentionOptions,
  DetectionFrameSelectionOptions,
  DetectionPlaybackGateOptions,
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { MediaInteractionOptions } from "#types/interaction";
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

export interface MediaSessionAppendableDetectionOptions {
  /**
   * Optional cold store. If omitted, the session creates an in-memory store.
   * `MemoryOnly` retention always uses an in-memory store.
   */
  readonly store?: ColdDetectionFrameStore;
  readonly datasetId: string;
  readonly chunkDurationSeconds?: number;
  readonly clearOnCreate?: boolean;
  readonly retention?: DetectionFrameRetentionOptions;
}

export type MediaSessionWritableDetectionOptions =
  MediaSessionAppendableDetectionOptions;

export type MediaSessionDetectionSyncOptions = DetectionFrameSelectionOptions;

export interface MediaSessionDetectionOptions {
  /**
   * Static detection frames known at session creation time.
   */
  readonly frames?: readonly DetectionFrame[];

  /**
   * Caller-owned source for loading detection frames by media-time range.
   */
  readonly source?: DetectionFrameSource;

  /**
   * Session-owned writable source for streaming detections into cold storage.
   * Prefer this name for new code.
   */
  readonly appendable?: MediaSessionAppendableDetectionOptions;

  /**
   * Backward-compatible alias for `appendable`.
   */
  readonly writable?: MediaSessionWritableDetectionOptions;

  /**
   * Detection-frame selection options shared by the hot buffer and renderer.
   */
  readonly sync?: MediaSessionDetectionSyncOptions;

  /**
   * Hot detection-window loading options.
   */
  readonly buffer?: DetectionBufferOptions;

  /**
   * Optional playback gate that treats detection coverage as part of media
   * readiness.
   */
  readonly playbackGate?: DetectionPlaybackGateOptions;
}

export interface MediaSessionRendererOptions {
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  readonly fit?: MediaRendererFit;
  readonly interaction?: MediaInteractionOptions;
  readonly renderPreparation?: MediaRendererOptions["renderPreparation"];
  readonly diagnostics?: MediaRendererOptions["diagnostics"];
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

export interface MediaSessionOptions {
  readonly container: HTMLElement;
  readonly media: MediaSessionMedia;
  readonly mode?: MediaSessionMode;
  readonly normalize?: false | MediaSessionNormalizationOptions;
  readonly detections?: MediaSessionDetectionOptions;
  readonly onState?: (state: MediaSessionState) => void;
  readonly presentation?: MediaRendererPresentation;
  readonly renderer?: MediaSessionRendererOptions;
}

export enum MediaSessionMode {
  File = "file",
  Stream = "stream",
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
  /**
   * True when this activity should prevent media playback from advancing.
   */
  readonly blockingPlayback: boolean;
  /**
   * True when this activity prevents the current visual frame from being fully
   * presented, while media playback may still be allowed to advance.
   */
  readonly blockingPresentation: boolean;
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

export type MediaSessionStateListener = (state: MediaSessionState) => void;
export type MediaSessionStateUnsubscribe = () => void;

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
  subscribe(listener: MediaSessionStateListener): MediaSessionStateUnsubscribe;
  getState(): MediaSessionState;
  destroy(): void;
}
