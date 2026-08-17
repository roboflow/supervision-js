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
  /** Frames a missing track may survive. */
  readonly maxAge?: number;
  /** Consecutive hits before a track is reported as confirmed in diagnostics. */
  readonly minHits?: number;
  /** Minimum intersection-over-union accepted by Hungarian assignment. */
  readonly iouThreshold?: number;
  /** Prevent detections with different class names from being associated. */
  readonly matchByClass?: boolean;
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
