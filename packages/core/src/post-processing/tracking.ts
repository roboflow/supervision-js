import type { Detection, DetectionFrame, Rect } from "#types/detections";
import {
  TrackingGeometry,
  type ByteTrackTrackingOptions,
  type CBIoUTrackingOptions,
  type DetectionPostProcessorFactory,
  type OCSortTrackingOptions,
  type SortTrackingOptions,
  type TrackingDetectionPostProcessor,
  type TrackingProjection,
} from "#types/post-processing";
import { computeDetectionMaskRect } from "#utils/detection-masks";
import { getPointsRect } from "#utils/geometry";

const DEFAULT_LOST_TRACK_BUFFER = 30;
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_TRACK_ACTIVATION_THRESHOLD = 0.25;
const DEFAULT_MINIMUM_CONSECUTIVE_FRAMES = 3;
const DEFAULT_MINIMUM_IOU_THRESHOLD = 0.3;
const DEFAULT_BYTE_TRACK_ACTIVATION_THRESHOLD = 0.7;
const DEFAULT_BYTE_MINIMUM_CONSECUTIVE_FRAMES = 2;
const DEFAULT_BYTE_MINIMUM_IOU_THRESHOLD = 0.1;
const DEFAULT_HIGH_CONFIDENCE_DETECTION_THRESHOLD = 0.6;
const DEFAULT_CBIOU_FIRST_IOU_THRESHOLD = 0.2;
const DEFAULT_CBIOU_SECOND_IOU_THRESHOLD = 0.5;
const DEFAULT_CBIOU_UNCONFIRMED_IOU_THRESHOLD = 0.3;
const DEFAULT_CBIOU_FIRST_BUFFER_RATIO = 0.3;
const DEFAULT_CBIOU_SECOND_BUFFER_RATIO = 0.5;
const DEFAULT_OCSORT_DIRECTION_CONSISTENCY_WEIGHT = 0.2;
const DEFAULT_OCSORT_DELTA_T = 3;

export const detectionPostProcessors: DetectionPostProcessorFactory = {
  tracking: ((
    options: SortTrackingOptions &
      ByteTrackTrackingOptions & {
        readonly algorithm?: "sort" | "bytetrack" | "cbiou" | "ocsort";
        readonly geometry?: TrackingGeometry;
      } & CBIoUTrackingOptions &
      OCSortTrackingOptions = {},
  ): TrackingDetectionPostProcessor => {
    const isByteTrack = options.algorithm === "bytetrack";
    const isCBIoU = options.algorithm === "cbiou";
    const isOCSort = options.algorithm === "ocsort";
    const lostTrackBuffer = normalizeNonNegativeInteger(
      options.lostTrackBuffer,
      DEFAULT_LOST_TRACK_BUFFER,
      "lostTrackBuffer",
    );
    const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
    const trackActivationThreshold =
      options.trackActivationThreshold ??
      (isByteTrack || isCBIoU
        ? DEFAULT_BYTE_TRACK_ACTIVATION_THRESHOLD
        : DEFAULT_TRACK_ACTIVATION_THRESHOLD);
    const minimumConsecutiveFrames = normalizePositiveInteger(
      options.minimumConsecutiveFrames,
      isByteTrack || isCBIoU
        ? DEFAULT_BYTE_MINIMUM_CONSECUTIVE_FRAMES
        : DEFAULT_MINIMUM_CONSECUTIVE_FRAMES,
      "minimumConsecutiveFrames",
    );
    const minimumIouThreshold =
      options.minimumIouThreshold ??
      (isByteTrack
        ? DEFAULT_BYTE_MINIMUM_IOU_THRESHOLD
        : DEFAULT_MINIMUM_IOU_THRESHOLD);

    if (!Number.isFinite(frameRate) || frameRate <= 0) {
      throw new Error("frameRate must be a finite positive value.");
    }
    normalizeUnitInterval(trackActivationThreshold, "trackActivationThreshold");
    normalizeUnitInterval(minimumIouThreshold, "minimumIouThreshold");

    const base = {
      geometry: options.geometry ?? TrackingGeometry.Box,
      kind: "tracking",
    } as const;

    if (isCBIoU) {
      const highConfidenceDetectionThreshold =
        options.highConfidenceDetectionThreshold ??
        DEFAULT_HIGH_CONFIDENCE_DETECTION_THRESHOLD;
      const minimumIouThresholdFirstAssociation =
        options.minimumIouThresholdFirstAssociation ??
        DEFAULT_CBIOU_FIRST_IOU_THRESHOLD;
      const minimumIouThresholdSecondAssociation =
        options.minimumIouThresholdSecondAssociation ??
        DEFAULT_CBIOU_SECOND_IOU_THRESHOLD;
      const minimumIouThresholdUnconfirmedAssociation =
        options.minimumIouThresholdUnconfirmedAssociation ??
        DEFAULT_CBIOU_UNCONFIRMED_IOU_THRESHOLD;
      const bufferRatioFirst =
        options.bufferRatioFirst ?? DEFAULT_CBIOU_FIRST_BUFFER_RATIO;
      const bufferRatioSecond =
        options.bufferRatioSecond ?? DEFAULT_CBIOU_SECOND_BUFFER_RATIO;
      normalizeUnitInterval(
        highConfidenceDetectionThreshold,
        "highConfidenceDetectionThreshold",
      );
      normalizeUnitInterval(
        minimumIouThresholdFirstAssociation,
        "minimumIouThresholdFirstAssociation",
      );
      normalizeUnitInterval(
        minimumIouThresholdSecondAssociation,
        "minimumIouThresholdSecondAssociation",
      );
      normalizeUnitInterval(
        minimumIouThresholdUnconfirmedAssociation,
        "minimumIouThresholdUnconfirmedAssociation",
      );
      normalizeNonNegativeFinite(bufferRatioFirst, "bufferRatioFirst");
      normalizeNonNegativeFinite(bufferRatioSecond, "bufferRatioSecond");
      return {
        ...base,
        algorithm: "cbiou" as const,
        options: {
          bufferRatioFirst,
          bufferRatioSecond,
          frameRate,
          highConfidenceDetectionThreshold,
          instantFirstFrameActivation:
            options.instantFirstFrameActivation ?? true,
          lostTrackBuffer,
          minimumConsecutiveFrames,
          minimumIouThresholdFirstAssociation,
          minimumIouThresholdSecondAssociation,
          minimumIouThresholdUnconfirmedAssociation,
          trackActivationThreshold,
        },
      };
    }

    if (isOCSort) {
      const directionConsistencyWeight =
        options.directionConsistencyWeight ??
        DEFAULT_OCSORT_DIRECTION_CONSISTENCY_WEIGHT;
      const highConfidenceDetectionThreshold =
        options.highConfidenceDetectionThreshold ??
        DEFAULT_HIGH_CONFIDENCE_DETECTION_THRESHOLD;
      const deltaT = normalizePositiveInteger(
        options.deltaT,
        DEFAULT_OCSORT_DELTA_T,
        "deltaT",
      );
      normalizeUnitInterval(
        directionConsistencyWeight,
        "directionConsistencyWeight",
      );
      normalizeUnitInterval(
        highConfidenceDetectionThreshold,
        "highConfidenceDetectionThreshold",
      );
      return {
        ...base,
        algorithm: "ocsort" as const,
        options: {
          deltaT,
          directionConsistencyWeight,
          frameRate,
          highConfidenceDetectionThreshold,
          lostTrackBuffer,
          minimumConsecutiveFrames,
          minimumIouThreshold,
        },
      };
    }

    if (isByteTrack) {
      const highConfidenceDetectionThreshold =
        options.highConfidenceDetectionThreshold ??
        DEFAULT_HIGH_CONFIDENCE_DETECTION_THRESHOLD;
      normalizeUnitInterval(
        highConfidenceDetectionThreshold,
        "highConfidenceDetectionThreshold",
      );
      return {
        ...base,
        algorithm: "bytetrack" as const,
        options: {
          frameRate,
          highConfidenceDetectionThreshold,
          lostTrackBuffer,
          minimumConsecutiveFrames,
          minimumIouThreshold,
          trackActivationThreshold,
        },
      };
    }

    return {
      ...base,
      algorithm: "sort" as const,
      options: {
        frameRate,
        lostTrackBuffer,
        minimumConsecutiveFrames,
        minimumIouThreshold,
        trackActivationThreshold,
      },
    };
  }) as DetectionPostProcessorFactory["tracking"],
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

function normalizeNonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative value.`);
  }
}
