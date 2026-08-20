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

export interface CBIoUTrackingOptions {
  /** Missing-track buffer expressed in 30 FPS frames. */
  readonly lostTrackBuffer?: number;
  /** Source frame rate used to scale `lostTrackBuffer`. */
  readonly frameRate?: number;
  /** Minimum confidence required to create a new track. */
  readonly trackActivationThreshold?: number;
  /** Successful observations required before a track receives an ID. */
  readonly minimumConsecutiveFrames?: number;
  /** Minimum fused buffered-IoU score in the high-confidence pass. */
  readonly minimumIouThresholdFirstAssociation?: number;
  /** Minimum buffered IoU in the low-confidence recovery pass. */
  readonly minimumIouThresholdSecondAssociation?: number;
  /** Minimum fused buffered-IoU score for tentative tracks. */
  readonly minimumIouThresholdUnconfirmedAssociation?: number;
  /** Confidence boundary between the first and second association stages. */
  readonly highConfidenceDetectionThreshold?: number;
  /** Whether eligible detections on the first frame receive IDs immediately. */
  readonly instantFirstFrameActivation?: boolean;
  /** Proportional box expansion used by the first association stage. */
  readonly bufferRatioFirst?: number;
  /** Proportional box expansion used by the second association stage. */
  readonly bufferRatioSecond?: number;
}

export interface OCSortTrackingOptions {
  /** Missing-track buffer expressed in 30 FPS frames. */
  readonly lostTrackBuffer?: number;
  /** Source frame rate used to scale `lostTrackBuffer`. */
  readonly frameRate?: number;
  /** Consecutive observations required before a recovered track emits its ID. */
  readonly minimumConsecutiveFrames?: number;
  /** Minimum IoU accepted by primary and last-observation association. */
  readonly minimumIouThreshold?: number;
  /** Weight applied to observation-centric motion-direction consistency. */
  readonly directionConsistencyWeight?: number;
  /** Minimum confidence eligible for association and track creation. */
  readonly highConfidenceDetectionThreshold?: number;
  /** Observation-history lookback used to estimate motion direction. */
  readonly deltaT?: number;
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

export interface CBIoUTrackingDetectionPostProcessor {
  readonly kind: "tracking";
  readonly algorithm: "cbiou";
  readonly geometry: TrackingGeometry;
  readonly options: Required<CBIoUTrackingOptions>;
}

export interface OCSortTrackingDetectionPostProcessor {
  readonly kind: "tracking";
  readonly algorithm: "ocsort";
  readonly geometry: TrackingGeometry;
  readonly options: Required<OCSortTrackingOptions>;
}

export type TrackingDetectionPostProcessor =
  | SortTrackingDetectionPostProcessor
  | ByteTrackTrackingDetectionPostProcessor
  | CBIoUTrackingDetectionPostProcessor
  | OCSortTrackingDetectionPostProcessor;

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

export type CBIoUTrackerUpdate = SortTrackerUpdate;
export type CBIoUTracker = SortTracker;

export type OCSortTrackerUpdate = SortTrackerUpdate;
export type OCSortTracker = SortTracker;

export type TrackingTracker =
  SortTracker | ByteTrackTracker | CBIoUTracker | OCSortTracker;

export interface DetectionPostProcessorFactory {
  tracking(
    options: CBIoUTrackingOptions & {
      readonly algorithm: "cbiou";
      readonly geometry?: TrackingGeometry;
    },
  ): CBIoUTrackingDetectionPostProcessor;
  tracking(
    options: OCSortTrackingOptions & {
      readonly algorithm: "ocsort";
      readonly geometry?: TrackingGeometry;
    },
  ): OCSortTrackingDetectionPostProcessor;
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
