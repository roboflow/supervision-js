/** Axis-aligned rectangle consumed by tracker engines. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Lightweight observation passed to a tracker. Heavy detection payloads stay outside this package. */
export interface TrackingProjection {
  readonly confidence?: number;
  readonly detectionIndex: number;
  readonly rect: Rect;
}

export interface TrackingAssignment {
  readonly detectionIndex: number;
  readonly trackerId: number;
}

export interface TrackerUpdate {
  readonly assignments: readonly TrackingAssignment[];
  readonly activeTrackCount: number;
  readonly confirmedTrackCount: number;
}

export interface Tracker {
  reset(): void;
  update(
    detections: readonly TrackingProjection[],
    frameIndex?: number,
  ): TrackerUpdate;
}

export interface SortTrackingOptions {
  readonly lostTrackBuffer?: number;
  readonly frameRate?: number;
  readonly trackActivationThreshold?: number;
  readonly minimumConsecutiveFrames?: number;
  readonly minimumIouThreshold?: number;
}

export interface ByteTrackTrackingOptions {
  readonly lostTrackBuffer?: number;
  readonly frameRate?: number;
  readonly trackActivationThreshold?: number;
  readonly minimumConsecutiveFrames?: number;
  readonly minimumIouThreshold?: number;
  readonly highConfidenceDetectionThreshold?: number;
}

export interface CBIoUTrackingOptions {
  readonly lostTrackBuffer?: number;
  readonly frameRate?: number;
  readonly trackActivationThreshold?: number;
  readonly minimumConsecutiveFrames?: number;
  readonly minimumIouThresholdFirstAssociation?: number;
  readonly minimumIouThresholdSecondAssociation?: number;
  readonly minimumIouThresholdUnconfirmedAssociation?: number;
  readonly highConfidenceDetectionThreshold?: number;
  readonly instantFirstFrameActivation?: boolean;
  readonly bufferRatioFirst?: number;
  readonly bufferRatioSecond?: number;
}

export interface OCSortTrackingOptions {
  readonly lostTrackBuffer?: number;
  readonly frameRate?: number;
  readonly minimumConsecutiveFrames?: number;
  readonly minimumIouThreshold?: number;
  readonly directionConsistencyWeight?: number;
  readonly highConfidenceDetectionThreshold?: number;
  readonly deltaT?: number;
}

export type SortTrackerUpdate = TrackerUpdate;
export type ByteTrackTrackerUpdate = TrackerUpdate;
export type CBIoUTrackerUpdate = TrackerUpdate;
export type OCSortTrackerUpdate = TrackerUpdate;

export type SortTracker = Tracker;
export type ByteTrackTracker = Tracker;
export type CBIoUTracker = Tracker;
export type OCSortTracker = Tracker;
