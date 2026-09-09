import type { MediaErrorKind } from "#types/media-rendering";

/**
 * Media-session operating mode.
 *
 * Core owns the names because file-like and stream-like lifecycle choices are
 * platform-neutral. Platform packages decide how these modes tune media,
 * storage, and renderer defaults.
 */
export enum MediaSessionMode {
  /**
   * Finite media. Defaults usually favor seek/replay and persistent detection
   * storage.
   */
  File = "file",
  /**
   * Live or append-only media. Defaults usually favor rolling windows and
   * bounded retention.
   */
  Stream = "stream",
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
  /**
   * Playback is held waiting for a producer to emit detections for the frame
   * about to be shown, which is a wait on inference rather than on transfer or
   * decode. `DetectionsBuffering` is the transfer of detections that already
   * exist, and `PlaybackBuffering` is the wait for media bytes.
   */
  DetectionsAwaitingCoverage = "detectionsAwaitingCoverage",
  DetectionsBuffering = "detectionsBuffering",
  DetectionsLoading = "detectionsLoading",
  Error = "error",
  MediaNormalizing = "mediaNormalizing",
  MediaOpening = "mediaOpening",
  /**
   * The picture is waiting on media the source has not handed over yet, which
   * is the bytes and their decode rather than anything downstream of them.
   * `PlaybackBuffering` is what a transport reports once it has already
   * stopped; this is reported from the read itself, including the reads a seek
   * makes while the transport still reads as paused.
   */
  MediaSourceReading = "mediaSourceReading",
  PlaybackBuffering = "playbackBuffering",
  /**
   * The render-preparation gate held the picture for artifacts that never
   * arrived and let it go. Nothing is blocked: the frames reaching the screen
   * are the ones whose artifacts were given up on. What is waited on is
   * preparation finishing another frame, which is what lets the gate hold the
   * picture again; `RenderPreparing` covers the holds that are running.
   */
  RenderPreparationAbandoned = "renderPreparationAbandoned",
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
 * `artifactKind` is intentionally a string. Platform packages can report
 * renderer-specific artifact families without making core import renderer
 * enums or prepared-artifact internals.
 */
export interface MediaSessionActivity {
  readonly artifactKind?: string;
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
  /**
   * Stable failure classification when this activity reports an error.
   *
   * Prefer this over `errorMessage` for control flow: messages are diagnostic
   * text and may name vendor internals. Absent when the reporting subsystem
   * does not classify its failures.
   */
  readonly errorKind?: MediaErrorKind | null;
  readonly errorMessage?: string | null;
  readonly kind: MediaSessionActivityKind;
  readonly label: string;
  readonly pendingCount?: number;
  readonly preparedCount?: number;
  readonly progress?: number;
  readonly status: MediaSessionActivityStatus;
}

/**
 * Platform-neutral aggregate state shell.
 *
 * Browser, React Native, and future packages bind their own media, renderer,
 * normalization, and render-preparation payloads into this shape.
 */
export interface MediaSessionLifecycleState<
  TMedia,
  TRenderer,
  TNormalization = unknown,
  TRenderPreparation = unknown,
> {
  readonly activities: readonly MediaSessionActivity[];
  readonly errorMessage: string | null;
  readonly media: TMedia;
  readonly normalization: TNormalization | null;
  /**
   * True when at least one activity should prevent playback from advancing.
   */
  readonly playbackBlocked: boolean;
  /**
   * True when at least one activity prevents the current visual frame from
   * being fully presented.
   */
  readonly presentationBlocked: boolean;
  readonly renderPreparation: TRenderPreparation | null;
  readonly renderer: TRenderer | null;
  readonly status: MediaSessionStatus;
}

export type MediaSessionStateListener<TState> = (state: TState) => void;
export type MediaSessionStateUnsubscribe = () => void;
