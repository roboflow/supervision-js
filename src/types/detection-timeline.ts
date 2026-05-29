import type { DetectionFrame } from "#types/detections";

export enum DetectionBufferStatus {
  Idle = "idle",
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

export enum DetectionFrameSelectionMode {
  Interval = "interval",
  NearestFrameIndex = "nearestFrameIndex",
}

export interface DetectionFrameSelectionOptions {
  readonly selectionMode?: DetectionFrameSelectionMode;
  readonly frameRate?: number;
  readonly frameIndexOriginTime?: number;
}

export interface DetectionBufferOptions extends DetectionFrameSelectionOptions {
  readonly bufferAheadSeconds?: number;
  readonly bufferBehindSeconds?: number;
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
  loadFrames(
    startTime: number,
    endTime: number,
  ): Promise<readonly DetectionFrame[]>;
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
  prepare(mediaTime: number): Promise<void>;
  prefetch(mediaTime: number): void;
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
  loadFrames(
    options: ColdDetectionFrameStoreLoadOptions,
  ): Promise<readonly DetectionFrame[]>;
  clearDataset(datasetId: string): Promise<void>;
  destroy?(): void;
}
