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

/**
 * Media input accepted by `createMediaSession`.
 *
 * Use a `Blob` for uploaded files, a URL string for already hosted media, or a
 * custom renderer source when integrating a lower-level media adapter.
 */
export type MediaSessionMedia = string | Blob | MediaRendererSource;

export interface MediaSessionNormalizationOptions extends MediaNormalizationOptions {
  /**
   * When true, media normalization may expose progressive output before the
   * entire input has finished normalizing.
   */
  readonly stream?: boolean;
}

/**
 * Options for session-owned streaming detection ingestion.
 */
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

/**
 * @deprecated Use `MediaSessionAppendableDetectionOptions`.
 */
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
   *
   * @deprecated Use `appendable`.
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

/**
 * Options for creating one renderer-owned media session.
 */
export interface MediaSessionOptions {
  /**
   * DOM element where the renderer should mount its canvas.
   */
  readonly container: HTMLElement;
  /**
   * Media to prepare and render. This can be a URL, an uploaded file/blob, or a
   * lower-level renderer source.
   */
  readonly media: MediaSessionMedia;
  /**
   * File mode is bounded media. Stream mode tunes defaults for live or
   * append-only detection sources.
   */
  readonly mode?: MediaSessionMode;
  /**
   * Optional browser media normalization before rendering.
   */
  readonly normalize?: false | MediaSessionNormalizationOptions;
  /**
   * Detection frames or sources to render with the media.
   */
  readonly detections?: MediaSessionDetectionOptions;
  /**
   * Aggregate loading, playback, buffering, processing, and error state.
   */
  readonly onState?: (state: MediaSessionState) => void;
  /**
   * Box, mask, and label presentation styles.
   */
  readonly presentation?: MediaRendererPresentation;
  /**
   * Renderer playback, interaction, diagnostics, and render-preparation options.
   */
  readonly renderer?: MediaSessionRendererOptions;
}

export enum MediaSessionMode {
  /**
   * Finite media. Defaults favor seek/replay and persistent detection storage.
   */
  File = "file",
  /**
   * Live or append-only media. Defaults favor rolling windows and bounded
   * retention.
   */
  Stream = "stream",
}

/**
 * Prepared media state visible to host applications.
 */
export interface MediaSessionMediaState {
  readonly inputMetadata: MediaNormalizationInputMetadata | null;
  readonly normalizedMedia: NormalizedMedia | ProgressiveNormalizedMedia | null;
  readonly objectUrl: string | null;
}

/**
 * Aggregate lifecycle state for a media session.
 */
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

/**
 * Subsystem currently affecting session readiness or presentation.
 */
export enum MediaSessionActivityKind {
  DetectionsBuffering = "detectionsBuffering",
  DetectionsLoading = "detectionsLoading",
  Error = "error",
  MediaNormalizing = "mediaNormalizing",
  MediaOpening = "mediaOpening",
  PlaybackBuffering = "playbackBuffering",
  RenderPreparing = "renderPreparing",
}

/**
 * State of one session activity.
 */
export enum MediaSessionActivityStatus {
  Error = "error",
  Running = "running",
  Waiting = "waiting",
}

/**
 * One loading, waiting, processing, or error activity.
 *
 * Host applications can render these as media overlays, status bars, or debug
 * panels without reaching into renderer internals.
 */
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

/**
 * Current aggregate state for media, renderer, detections, render preparation,
 * loading activities, and errors.
 */
export interface MediaSessionState {
  readonly activities: readonly MediaSessionActivity[];
  readonly errorMessage: string | null;
  readonly media: MediaSessionMediaState;
  readonly normalization: MediaSessionNormalizationState | null;
  /**
   * True when at least one activity should prevent playback from advancing.
   */
  readonly playbackBlocked: boolean;
  /**
   * True when at least one activity prevents the current visual frame from
   * being fully presented.
   */
  readonly presentationBlocked: boolean;
  readonly renderPreparation: RenderPreparationDiagnostics | null;
  readonly renderer: MediaRendererState | null;
  readonly status: MediaSessionStatus;
}

export type MediaSessionStateListener = (state: MediaSessionState) => void;
export type MediaSessionStateUnsubscribe = () => void;

/**
 * Public controller for one renderer-owned media item.
 */
export interface MediaSession {
  /**
   * Detection source used by the renderer. Present when the session was created
   * with static frames, a source, or an appendable source.
   */
  readonly detectionSource?:
    | DetectionFrameSource
    | WritableDetectionFrameSource;
  readonly media: MediaSessionMediaState;
  readonly renderer: MediaRenderer;
  /**
   * Append semantic detection frames to a session-owned appendable source.
   */
  appendDetectionFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  /**
   * Summary of frames written through `appendDetectionFrames`, when available.
   */
  getDetectionSummary(): ColdDetectionFrameStoreWriteSummary | null;
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  setPresentation(presentation: MediaRendererPresentation): void;
  subscribe(listener: MediaSessionStateListener): MediaSessionStateUnsubscribe;
  getState(): MediaSessionState;
  destroy(): void;
}
