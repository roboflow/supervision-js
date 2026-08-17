import {
  DetectionTrackerState,
  type Detection,
  type DetectionFrame,
  type Rect,
} from "#types/detections";
import {
  TrackingGeometry,
  type DetectionPostProcessorFactory,
  type TrackingProjection,
} from "#types/post-processing";
import { computeDetectionMaskRect } from "#utils/detection-masks";
import { getPointsRect } from "#utils/geometry";

const DEFAULT_MAX_AGE = 30;
const DEFAULT_MIN_HITS = 3;
const DEFAULT_IOU_THRESHOLD = 0.3;

export const detectionPostProcessors: DetectionPostProcessorFactory = {
  tracking(options = {}) {
    const maxAge = normalizeInteger(options.maxAge, DEFAULT_MAX_AGE, "maxAge");
    const minHits = normalizeInteger(
      options.minHits,
      DEFAULT_MIN_HITS,
      "minHits",
    );
    const iouThreshold = options.iouThreshold ?? DEFAULT_IOU_THRESHOLD;

    if (
      !Number.isFinite(iouThreshold) ||
      iouThreshold < 0 ||
      iouThreshold > 1
    ) {
      throw new Error("iouThreshold must be between 0 and 1.");
    }

    return {
      algorithm: options.algorithm ?? "sort",
      geometry: options.geometry ?? TrackingGeometry.Box,
      kind: "tracking",
      options: {
        emitPredictions: options.emitPredictions ?? true,
        iouThreshold,
        matchByClass: options.matchByClass ?? true,
        maxAge,
        minHits,
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
    if (detection.trackerState === DetectionTrackerState.Predicted) {
      return [];
    }
    const rect = resolveTrackingRect(detection, geometry);

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return [];
    }

    return [
      {
        ...(detection.className === undefined
          ? {}
          : { className: detection.className }),
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

function normalizeInteger(
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
