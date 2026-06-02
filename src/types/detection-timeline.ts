import type { DetectionFrame } from "#types/detections";

export enum DetectionBufferStatus {
  Idle = "idle",
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

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
  readonly selectionMode?: DetectionFrameSelectionMode;
  readonly frameRate?: number;
  readonly frameIndexOriginTime?: number;
}

export interface DetectionFrameSourceVersionRange {
  readonly startTime: number;
  readonly endTime: number;
}

export interface DetectionBufferOptions extends DetectionFrameSelectionOptions {
  readonly bufferAheadSeconds?: number;
  readonly bufferBehindSeconds?: number;
  readonly refreshIntervalSeconds?: number;
  readonly playbackGate?: DetectionPlaybackGateOptions;
}

export interface DetectionTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}

export interface DetectionPlaybackGateOptions {
  readonly enabled?: boolean;
  readonly requiredAheadSeconds?: number;
}

export enum DetectionFrameRetentionMode {
  MemoryOnly = "memoryOnly",
  PersistAll = "persistAll",
  PersistWindow = "persistWindow",
}

export interface DetectionFrameRetentionOptions {
  readonly mode?: DetectionFrameRetentionMode;
  readonly windowSeconds?: number;
}

export interface DetectionBufferPrepareOptions {
  readonly duration?: number | null;
  readonly firstTimestamp?: number;
  readonly gatePlayback?: boolean;
}

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
  waitForRange?(range: DetectionFrameSourceVersionRange): Promise<void>;
  getAvailableRanges?(): readonly DetectionFrameSourceVersionRange[];
  getVersion?(range?: DetectionFrameSourceVersionRange): number;
  destroy?(): void;
}

export interface DetectionFrameChunkDescriptor {
  readonly chunkIndex: number;
  readonly startTime: number;
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
  readonly baseUrl?: string | URL;
  readonly fetchChunk?: DetectionFrameChunkFetch;
  readonly maxCachedChunks?: number;
}

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

export interface ColdDetectionFrameStoreWriteOptions {
  readonly datasetId: string;
  readonly frames: readonly DetectionFrame[];
  readonly chunkDurationSeconds?: number;
}

export interface ColdDetectionFrameStoreWriteSummary {
  readonly datasetId: string;
  readonly chunkDurationSeconds: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly detectionCount: number;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

export interface ColdDetectionFrameStoreLoadOptions {
  readonly datasetId: string;
  readonly startTime: number;
  readonly endTime: number;
}

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
