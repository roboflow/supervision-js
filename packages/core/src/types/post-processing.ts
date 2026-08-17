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
  /** Emit predicted detections while confirmed tracks cross observation gaps. */
  readonly emitPredictions?: boolean;
}

export interface TrackingDetectionPostProcessor {
  readonly kind: "tracking";
  readonly algorithm: "sort";
  readonly geometry: TrackingGeometry;
  readonly options: Required<SortTrackingOptions>;
}

export interface TrackingProjection {
  readonly className?: string;
  readonly confidence?: number;
  readonly detectionIndex: number;
  readonly rect: Rect;
}

export interface TrackingAssignment {
  readonly detectionIndex: number;
  readonly trackerId: number;
}

/** A confirmed track predicted into a frame with no matching observation. */
export interface TrackingPrediction {
  readonly trackerId: number;
  readonly className?: string;
  /** Frames since this track was last observed. */
  readonly ageFrames: number;
  readonly rect: Rect;
}

export interface SortTrackerUpdate {
  readonly assignments: readonly TrackingAssignment[];
  readonly predictions: readonly TrackingPrediction[];
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

export interface DetectionPostProcessorFactory {
  tracking(
    options?: SortTrackingOptions & {
      readonly algorithm?: "sort";
      readonly geometry?: TrackingGeometry;
    },
  ): TrackingDetectionPostProcessor;
}

export type TrackingFrameProjector = (
  frame: DetectionFrame,
  geometry: TrackingGeometry,
) => readonly TrackingProjection[];
