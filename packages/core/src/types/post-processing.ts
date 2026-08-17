import type { DetectionFrame, Rect } from "#types/detections";

/** Built-in semantic detection post-processors. */
export type DetectionPostProcessor = TrackingDetectionPostProcessor;

/** Geometry projected into a tracker. The original detection payload is retained. */
export enum TrackingGeometry {
  Box = "box",
  Mask = "mask",
  Keypoints = "keypoints",
}

export interface SortTrackingOptions {
  /** Missing-track buffer expressed in 30 FPS frames. Zero removes on the first miss. */
  readonly lostTrackBuffer?: number;
  /** Source frame rate used to scale `lostTrackBuffer`. */
  readonly frameRate?: number;
  /** Minimum confidence required to create a new track. Missing confidence is 1. */
  readonly trackActivationThreshold?: number;
  /** Successful observations required before a track receives an ID. */
  readonly minimumConsecutiveFrames?: number;
  /** Minimum intersection-over-union accepted by assignment. */
  readonly minimumIouThreshold?: number;
}

export interface ByteTrackTrackingOptions {
  /** Missing-track buffer expressed in 30 FPS frames. Zero removes on the first miss. */
  readonly lostTrackBuffer?: number;
  /** Source frame rate used to scale `lostTrackBuffer`. */
  readonly frameRate?: number;
  /** Minimum confidence required to create a new track. Missing confidence is 1. */
  readonly trackActivationThreshold?: number;
  /** Consecutive observations required before a track receives an ID. */
  readonly minimumConsecutiveFrames?: number;
  /** Minimum intersection-over-union accepted by either association stage. */
  readonly minimumIouThreshold?: number;
  /** Confidence boundary between the first and second association stages. */
  readonly highConfidenceDetectionThreshold?: number;
}

export interface SortTrackingDetectionPostProcessor {
  readonly kind: "tracking";
  readonly algorithm: "sort";
  readonly geometry: TrackingGeometry;
  readonly options: Required<SortTrackingOptions>;
}

export interface ByteTrackTrackingDetectionPostProcessor {
  readonly kind: "tracking";
  readonly algorithm: "bytetrack";
  readonly geometry: TrackingGeometry;
  readonly options: Required<ByteTrackTrackingOptions>;
}

export type TrackingDetectionPostProcessor =
  SortTrackingDetectionPostProcessor | ByteTrackTrackingDetectionPostProcessor;

export interface TrackingProjection {
  readonly confidence?: number;
  readonly detectionIndex: number;
  readonly rect: Rect;
}

export interface TrackingAssignment {
  readonly detectionIndex: number;
  readonly trackerId: number;
}

export interface SortTrackerUpdate {
  readonly assignments: readonly TrackingAssignment[];
  readonly activeTrackCount: number;
  readonly confirmedTrackCount: number;
}

export interface SortTracker {
  reset(): void;
  update(
    detections: readonly TrackingProjection[],
    frameIndex?: number,
  ): SortTrackerUpdate;
}

export type ByteTrackTrackerUpdate = SortTrackerUpdate;

export interface ByteTrackTracker {
  reset(): void;
  update(
    detections: readonly TrackingProjection[],
    frameIndex?: number,
  ): ByteTrackTrackerUpdate;
}

export type TrackingTracker = SortTracker | ByteTrackTracker;

export interface DetectionPostProcessorFactory {
  tracking(
    options: ByteTrackTrackingOptions & {
      readonly algorithm: "bytetrack";
      readonly geometry?: TrackingGeometry;
    },
  ): ByteTrackTrackingDetectionPostProcessor;
  tracking(
    options?: SortTrackingOptions & {
      readonly algorithm?: "sort";
      readonly geometry?: TrackingGeometry;
    },
  ): SortTrackingDetectionPostProcessor;
}

export type TrackingFrameProjector = (
  frame: DetectionFrame,
  geometry: TrackingGeometry,
) => readonly TrackingProjection[];
