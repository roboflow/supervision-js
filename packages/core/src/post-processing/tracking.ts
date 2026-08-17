import type { Detection, DetectionFrame, Rect } from "#types/detections";
import {
  TrackingGeometry,
  type DetectionPostProcessorFactory,
  type TrackingProjection,
} from "#types/post-processing";
import { computeDetectionMaskRect } from "#utils/detection-masks";
import { getPointsRect } from "#utils/geometry";

const DEFAULT_LOST_TRACK_BUFFER = 30;
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_TRACK_ACTIVATION_THRESHOLD = 0.25;
const DEFAULT_MINIMUM_CONSECUTIVE_FRAMES = 3;
const DEFAULT_MINIMUM_IOU_THRESHOLD = 0.3;

export const detectionPostProcessors: DetectionPostProcessorFactory = {
  tracking(options = {}) {
    const lostTrackBuffer = normalizeNonNegativeInteger(
      options.lostTrackBuffer,
      DEFAULT_LOST_TRACK_BUFFER,
      "lostTrackBuffer",
    );
    const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
    const trackActivationThreshold =
      options.trackActivationThreshold ?? DEFAULT_TRACK_ACTIVATION_THRESHOLD;
    const minimumConsecutiveFrames = normalizePositiveInteger(
      options.minimumConsecutiveFrames,
      DEFAULT_MINIMUM_CONSECUTIVE_FRAMES,
      "minimumConsecutiveFrames",
    );
    const minimumIouThreshold =
      options.minimumIouThreshold ?? DEFAULT_MINIMUM_IOU_THRESHOLD;

    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error("frameRate must be a finite positive value.");
    }
    normalizeUnitInterval(trackActivationThreshold, "trackActivationThreshold");
    normalizeUnitInterval(minimumIouThreshold, "minimumIouThreshold");

    return {
      algorithm: options.algorithm ?? "sort",
      geometry: options.geometry ?? TrackingGeometry.Box,
      kind: "tracking",
      options: {
        frameRate,
        lostTrackBuffer,
        minimumConsecutiveFrames,
        minimumIouThreshold,
        trackActivationThreshold,
      },
    };
  },
};

/**
 * Creates the lightweight projection sent to a tracker or tracking worker.
 * Masks and keypoint arrays never cross the worker boundary.
 */
export function projectDetectionFrameForTracking(
  frame: DetectionFrame,
  geometry: TrackingGeometry,
): readonly TrackingProjection[] {
  return frame.detections.flatMap((detection, detectionIndex) => {
    const rect = resolveTrackingRect(detection, geometry);

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return [];
    }

    return [
      {
        ...(detection.confidence === undefined
          ? {}
          : { confidence: detection.confidence }),
        detectionIndex,
        rect,
      },
    ];
  });
}

function resolveTrackingRect(
  detection: Detection,
  geometry: TrackingGeometry,
): Rect | undefined {
  switch (geometry) {
    case TrackingGeometry.Box:
      return detection.rect;
    case TrackingGeometry.Mask:
      if (!detection.mask) {
        return undefined;
      }
      // Most segmentation producers already supply the exact mask bounds as a
      // rect. Decode RLE only when that inexpensive projection is absent.
      return detection.rect ?? computeDetectionMaskRect(detection.mask);
    case TrackingGeometry.Keypoints:
      return detection.keypoints
        ? getPointsRect(detection.keypoints.points)
        : undefined;
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
) {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return resolved;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
) {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return resolved;
}

function normalizeUnitInterval(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
}
