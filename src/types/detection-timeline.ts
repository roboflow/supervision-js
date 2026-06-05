import type { DetectionFrame } from "#types/detections";

export enum DetectionBufferStatus {
  Idle = "idle",
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * How the renderer selects the active detection frame for a media timestamp.
 */
export enum DetectionFrameSelectionMode {
  /**
   * Select the frame whose `[mediaTime, endTime)` interval contains the media
   * time. This is the default for interval annotations and timestamped sources.
   */
  Interval = "interval",

  /**
   * Select from a known inference frame grid using `frameIndex`, `frameRate`,
   * and optional `frameIndexOriginTime`. This is useful when inference was run
   * on normalized frames and playback should snap detections to that grid.
   */
  NearestFrameIndex = "nearestFrameIndex",
}

export interface DetectionFrameSelectionOptions {
  /**
   * Selection strategy for matching media playback time to detection frames.
   */
  readonly selectionMode?: DetectionFrameSelectionMode;
  /**
   * Inference frame rate used by `NearestFrameIndex`.
   */
  readonly frameRate?: number;
  /**
   * Media timestamp for inference frame index 0. Defaults to the first indexed
   * frame's time minus `frameIndex / frameRate`.
   */
  readonly frameIndexOriginTime?: number;
}

export interface DetectionFrameSourceVersionRange {
  /**
   * Inclusive media-time start in seconds.
   */
  readonly startTime: number;
  /**
   * Exclusive media-time end in seconds.
   */
  readonly endTime: number;
}

export interface DetectionBufferOptions extends DetectionFrameSelectionOptions {
  /**
   * Seconds of detections to keep loaded ahead of playback.
   */
  readonly bufferAheadSeconds?: number;
  /**
   * Seconds of detections to keep loaded behind playback.
   */
  readonly bufferBehindSeconds?: number;
  /**
   * Minimum media-time movement before refreshing the hot detection window.
   */
  readonly refreshIntervalSeconds?: number;
  /**
   * Optional playback gate based on detection availability.
   */
  readonly playbackGate?: DetectionPlaybackGateOptions;
}

export interface DetectionTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}

export interface DetectionPlaybackGateOptions {
  /**
   * Pause playback while the requested detection window is unavailable.
   */
  readonly enabled?: boolean;
  /**
   * Required detections ahead of the active playback time.
   */
  readonly requiredAheadSeconds?: number;
}

export enum DetectionFrameRetentionMode {
  /**
   * Keep writable detections only in an in-memory store. Useful for ephemeral
   * live streams where old predictions should disappear when evicted.
   */
  MemoryOnly = "memoryOnly",

  /**
   * Persist every written detection frame. Useful for finite media where seek
   * and replay should not require recomputing detections.
   */
  PersistAll = "persistAll",

  /**
   * Persist only the most recent retention window. Useful for long-running
   * streams where replay is bounded to a recent time horizon.
   */
  PersistWindow = "persistWindow",
}

export interface DetectionFrameRetentionOptions {
  readonly mode?: DetectionFrameRetentionMode;
  /**
   * Retention horizon in seconds for `MemoryOnly` and `PersistWindow`.
   */
  readonly windowSeconds?: number;
}

export interface DetectionBufferPrepareOptions {
  readonly duration?: number | null;
  readonly firstTimestamp?: number;
  readonly gatePlayback?: boolean;
}

/**
 * Current hot detection-buffer state.
 */
export interface DetectionBufferState {
  readonly status: DetectionBufferStatus;
  readonly requestedStartTime: number | null;
  readonly requestedEndTime: number | null;
  readonly bufferStartTime: number | null;
  readonly bufferEndTime: number | null;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly errorMessage: string | null;
}

export interface DetectionFrameSource {
  /**
   * Load semantic detection frames for the requested media-time range.
   *
   * Sources should return detection data, not renderer artifacts. Implementers
   * should prefer sorted frames and avoid mutating returned frames after handing
   * them to the renderer.
   */
  loadFrames(
    startTime: number,
    endTime: number,
  ): Promise<readonly DetectionFrame[]>;
  /**
   * Optional backpressure hook used by playback gates. Resolve when the source
   * has enough data to answer `loadFrames` for the requested range.
   */
  waitForRange?(range: DetectionFrameSourceVersionRange): Promise<void>;
  /**
   * Optional source coverage report for timeline UI and buffering decisions.
   */
  getAvailableRanges?(): readonly DetectionFrameSourceVersionRange[];
  /**
   * Optional monotonically increasing source version. Buffered timelines use
   * this to refresh only when the current range changed.
   */
  getVersion?(range?: DetectionFrameSourceVersionRange): number;
  destroy?(): void;
}

export interface DetectionFrameChunkDescriptor {
  /**
   * Zero-based chunk index.
   */
  readonly chunkIndex: number;
  /**
   * Inclusive chunk start time in seconds.
   */
  readonly startTime: number;
  /**
   * Exclusive chunk end time in seconds.
   */
  readonly endTime: number;
  readonly frameCount: number;
  readonly src: string;
}

export interface DetectionFrameChunk {
  readonly frames: readonly DetectionFrame[];
}

export interface DetectionFrameChunkManifest {
  readonly schema: "supervision-js.detection-frame-chunk-manifest";
  readonly version: 1;
  /**
   * Stable identifier for the detection dataset.
   */
  readonly datasetId: string;
  readonly duration: number;
  readonly frameRate: number;
  readonly chunkDurationSeconds: number;
  readonly frameCount?: number;
  readonly detectionCount?: number;
  readonly chunks: readonly DetectionFrameChunkDescriptor[];
}

export type DetectionFrameChunkFetch = (
  chunk: DetectionFrameChunkDescriptor,
) => Promise<DetectionFrameChunk>;

export interface ChunkedDetectionFrameSourceOptions {
  readonly manifest: DetectionFrameChunkManifest;
  /**
   * Base URL used to resolve relative chunk `src` values.
   */
  readonly baseUrl?: string | URL;
  /**
   * Custom fetcher for chunk manifests. Defaults to browser `fetch`.
   */
  readonly fetchChunk?: DetectionFrameChunkFetch;
  /**
   * Maximum number of decoded chunks cached in memory.
   */
  readonly maxCachedChunks?: number;
}

/**
 * Hot detection timeline controller.
 */
export interface BufferedDetectionTimeline {
  prepare(
    mediaTime: number,
    options?: DetectionBufferPrepareOptions,
  ): Promise<void>;
  prefetch(mediaTime: number): void;
  setTimelineContext?(context: DetectionTimelineContext): void;
  selectFrame(mediaTime: number): DetectionFrame | undefined;
  getBufferedFrames(): readonly DetectionFrame[];
  getState(): DetectionBufferState;
  destroy(): void;
}

/**
 * Write options for semantic detection frames.
 */
export interface ColdDetectionFrameStoreWriteOptions {
  readonly datasetId: string;
  /**
   * Frames to validate, sort, and write.
   */
  readonly frames: readonly DetectionFrame[];
  /**
   * Chunk duration used for summaries and chunked persistence.
   */
  readonly chunkDurationSeconds?: number;
}

/**
 * Summary returned after detection-frame writes.
 */
export interface ColdDetectionFrameStoreWriteSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

/**
 * Load options for semantic detection frames.
 */
export interface ColdDetectionFrameStoreLoadOptions {
  readonly datasetId: string;
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Cold semantic detection storage.
 *
 * Stores validated detection frames outside the active render path. Browser
 * implementations may use IndexedDB; memory implementations are useful for
 * tests, demos, and ephemeral streams.
 */
export interface ColdDetectionFrameStore {
  putFrames(
    options: ColdDetectionFrameStoreWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  appendFrames(
    options: ColdDetectionFrameStoreWriteOptions,
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  loadFrames(
    options: ColdDetectionFrameStoreLoadOptions,
  ): Promise<readonly DetectionFrame[]>;
  clearDataset(datasetId: string): Promise<void>;
  destroy?(): void;
}

/**
 * Detection source that accepts new frames over time.
 *
 * This is the ingestion shape used for streaming inference and long-running
 * media sessions. It remains semantic: render artifacts are prepared later by
 * the renderer.
 */
export interface WritableDetectionFrameSource extends DetectionFrameSource {
  readonly datasetId: string;
  appendFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  replaceFrames(
    frames: readonly DetectionFrame[],
  ): Promise<ColdDetectionFrameStoreWriteSummary>;
  clear(): Promise<void>;
  waitForRange(range: DetectionFrameSourceVersionRange): Promise<void>;
  getAvailableRanges(): readonly DetectionFrameSourceVersionRange[];
  getSummary(): ColdDetectionFrameStoreWriteSummary | null;
  getVersion(range?: DetectionFrameSourceVersionRange): number;
}
