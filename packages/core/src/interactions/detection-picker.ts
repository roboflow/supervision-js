import {
  KeypointVisibility,
  type DetectionMask,
  type DetectionFrame,
  type Point,
} from "#types/detections";
import {
  DetectionPickTarget,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
} from "#types/interaction";
import { decodeCompressedRleMask } from "#utils/detection-frames";
import {
  containsPoint,
  distanceToSegment,
  getDetectionRect,
  pointInPolygon,
  polygonArea,
  rectArea,
} from "#utils/geometry";

interface CandidatePick {
  readonly area: number;
  readonly zIndex: number;
  readonly result: DetectionPickResult;
}

interface CachedDecodedMask {
  readonly pixelArea: number;
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

const decodedMaskCache = new WeakMap<DetectionMask, CachedDecodedMask>();

export function pickDetectionAtPoint(
  frame: DetectionFrame | undefined,
  point: DetectionPickPoint,
  options: DetectionPickOptions = {},
): DetectionPickResult | null {
  if (!frame) {
    return null;
  }

  const padding = Math.max(0, options.padding ?? 0);
  const polylinePadding = Math.max(0, options.polylinePadding ?? 6);
  const keypointPadding = Math.max(0, options.keypointPadding ?? 10);
  const edgePadding = Math.max(0, options.edgePadding ?? 8);
  const candidates: CandidatePick[] = [];

  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex];

    if (
      !detection ||
      (detection.locked && options.includeLocked === false) ||
      options.filter?.(detection, detectionIndex) === false
    ) {
      continue;
    }

    const detectionArea = Math.max(1, rectArea(getDetectionRect(detection)));
    const pushCandidate = (
      target: DetectionPickTarget,
      area = detectionArea,
      geometryIndex?: number,
    ) => {
      candidates.push({
        area,
        result: {
          detection,
          detectionIndex,
          frame,
          geometryIndex,
          mediaTime: frame.mediaTime,
          point,
          target,
        },
        zIndex: detection.zIndex ?? detectionIndex,
      });
    };

    if (detection.rect && containsPoint(detection.rect, point, padding)) {
      pushCandidate(DetectionPickTarget.Box, rectArea(detection.rect));
    }

    if (detection.polygon && pointInPolygon(point, detection.polygon.points)) {
      pushCandidate(
        DetectionPickTarget.Polygon,
        Math.max(1, polygonArea(detection.polygon.points)),
      );
    }

    if (detection.polyline) {
      const segmentIndex = findHitSegment(
        point,
        detection.polyline.points,
        polylinePadding,
        false,
      );

      if (segmentIndex !== -1) {
        pushCandidate(
          DetectionPickTarget.Polyline,
          detectionArea,
          segmentIndex,
        );
      }
    }

    if (detection.keypoints) {
      const keypointIndex = detection.keypoints.points.findIndex(
        (keypoint, index) =>
          detection.keypoints?.visibility?.[index] !==
            KeypointVisibility.NotLabeled &&
          Math.hypot(point.x - keypoint.x, point.y - keypoint.y) <=
            keypointPadding,
      );

      if (keypointIndex !== -1) {
        pushCandidate(
          DetectionPickTarget.Keypoint,
          Math.PI * keypointPadding * keypointPadding,
          keypointIndex,
        );
      } else {
        const edgeIndex = detection.keypoints.edges.findIndex(
          ([fromIndex, toIndex]) => {
            const from = detection.keypoints?.points[fromIndex];
            const to = detection.keypoints?.points[toIndex];

            return Boolean(
              from &&
              to &&
              detection.keypoints?.visibility?.[fromIndex] !==
                KeypointVisibility.NotLabeled &&
              detection.keypoints?.visibility?.[toIndex] !==
                KeypointVisibility.NotLabeled &&
              distanceToSegment(point, from, to) <= edgePadding,
            );
          },
        );

        if (edgeIndex !== -1) {
          pushCandidate(DetectionPickTarget.Edge, detectionArea, edgeIndex);
        }
      }
    }

    if (detection.mask && options.includeMasks !== false) {
      const decoded = getDecodedMask(detection.mask);
      const mediaDimensions = options.maskMediaDimensions;
      const x = Math.floor(
        mediaDimensions && mediaDimensions.width > 0
          ? (point.x / mediaDimensions.width) * decoded.width
          : point.x,
      );
      const y = Math.floor(
        mediaDimensions && mediaDimensions.height > 0
          ? (point.y / mediaDimensions.height) * decoded.height
          : point.y,
      );

      if (
        x >= 0 &&
        y >= 0 &&
        x < decoded.width &&
        y < decoded.height &&
        decoded.data[y * decoded.width + x]
      ) {
        pushCandidate(
          DetectionPickTarget.Mask,
          getMaskMediaArea(decoded, mediaDimensions),
        );
      }
    }
  }

  candidates.sort((left, right) => {
    const areaDifference = left.area - right.area;

    if (areaDifference !== 0) {
      return areaDifference;
    }

    const zIndexDifference = right.zIndex - left.zIndex;

    return zIndexDifference === 0
      ? right.result.detectionIndex - left.result.detectionIndex
      : zIndexDifference;
  });

  return candidates[0]?.result ?? null;
}

function getDecodedMask(mask: DetectionMask): CachedDecodedMask {
  const cached = decodedMaskCache.get(mask);
  if (cached) return cached;

  const decoded = decodeCompressedRleMask(mask);
  const result = {
    ...decoded,
    pixelArea: countMaskPixels(decoded.data),
  };
  decodedMaskCache.set(mask, result);
  return result;
}

function getMaskMediaArea(
  mask: CachedDecodedMask,
  mediaDimensions: DetectionPickOptions["maskMediaDimensions"],
) {
  if (
    !mediaDimensions ||
    mediaDimensions.width <= 0 ||
    mediaDimensions.height <= 0
  ) {
    return mask.pixelArea;
  }

  return (
    mask.pixelArea *
    (mediaDimensions.width / mask.width) *
    (mediaDimensions.height / mask.height)
  );
}

export function createDetectionPickKey(pick: DetectionPickResult | null) {
  if (!pick) {
    return null;
  }

  const frameKey = [pick.frame.frameIndex ?? "time", pick.frame.mediaTime];
  const detectionKey = detectionPickKey(pick);

  return [
    ...frameKey,
    ...detectionKey,
    pick.target,
    pick.geometryIndex ?? "geometry",
  ].join(":");
}

export function rebaseDetectionPickToFrame(
  pick: DetectionPickResult | null,
  frame: DetectionFrame | undefined,
): DetectionPickResult | null {
  if (!pick || !frame) {
    return null;
  }

  const detectionIndex =
    pick.detection.id === undefined ||
    !hasUniqueDetectionId(pick.frame, pick.detection.id)
      ? pick.detectionIndex
      : frame.detections.findIndex(
          (detection) => detection.id === pick.detection.id,
        );
  const detection = frame.detections[detectionIndex];

  if (!detection) {
    return null;
  }

  const rebasedPick = {
    detection,
    detectionIndex,
    frame,
    geometryIndex: pick.geometryIndex,
    mediaTime: frame.mediaTime,
    point: pick.point,
    target: pick.target,
  };

  return createDetectionPickKey(rebasedPick) === createDetectionPickKey(pick)
    ? rebasedPick
    : null;
}

function detectionPickKey(pick: DetectionPickResult) {
  if (pick.detection.id === undefined) {
    return ["anonymous", pick.detectionIndex];
  }

  return hasUniqueDetectionId(pick.frame, pick.detection.id)
    ? ["id", String(pick.detection.id)]
    : ["duplicate-id", String(pick.detection.id), "index", pick.detectionIndex];
}

function hasUniqueDetectionId(frame: DetectionFrame, id: string | number) {
  let count = 0;
  for (const detection of frame.detections) {
    if (detection.id !== id) continue;
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

export function pickDetectionByMaskId(
  frame: DetectionFrame | undefined,
  maskId: number,
  point: DetectionPickPoint,
): DetectionPickResult | null {
  if (!frame || maskId <= 0 || !Number.isInteger(maskId)) {
    return null;
  }

  const detectionIndex = maskId - 1;
  const detection = frame.detections[detectionIndex];

  if (!detection) {
    return null;
  }

  return {
    detection,
    detectionIndex,
    frame,
    mediaTime: frame.mediaTime,
    point,
    target: DetectionPickTarget.Mask,
  };
}

function findHitSegment(
  point: Point,
  points: readonly Point[],
  padding: number,
  closed: boolean,
) {
  const segmentCount = closed ? points.length : points.length - 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];

    if (start && end && distanceToSegment(point, start, end) <= padding) {
      return index;
    }
  }

  return -1;
}

function countMaskPixels(data: Uint8Array) {
  let count = 0;

  for (const value of data) {
    count += value ? 1 : 0;
  }

  return Math.max(1, count);
}
