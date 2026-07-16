/**
 * Pure conversion helpers for the geometry showcase fixture.
 *
 * These functions normalize offline model output into supervision-js
 * `Detection` geometry:
 *
 * - mask contours become bounded, deterministically simplified polygons;
 * - Python/model `xyxy` corner boxes become center-based `Rect` records;
 * - one-based COCO skeleton edges become zero-based `KeypointEdge` pairs;
 * - keypoint confidence maps onto an explicit visibility policy that only
 *   distinguishes `Visible` from `NotLabeled` (pose output has no true
 *   occlusion state, so `Occluded` is never invented).
 */

export const DEFAULT_MAX_POLYGON_POINTS = 48;
export const DEFAULT_POLYGON_TOLERANCE = 2;
export const DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE = 0.5;
export const DEFAULT_POSE_MATCH_IOU = 0.3;

export const KEYPOINT_VISIBILITY_NOT_LABELED = 0;
export const KEYPOINT_VISIBILITY_VISIBLE = 2;

/**
 * COCO-17 person skeleton edges as published by COCO and mirrored by the
 * Python Supervision keypoint annotators. Indexes are one-based vertex ids.
 */
export const COCO_SKELETON_EDGES_ONE_BASED = [
  [16, 14],
  [14, 12],
  [17, 15],
  [15, 13],
  [12, 13],
  [6, 12],
  [7, 13],
  [6, 7],
  [6, 8],
  [7, 9],
  [8, 10],
  [9, 11],
  [2, 3],
  [1, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [5, 7],
];

/**
 * Converts one-based skeleton edges (COCO / Python Supervision annotator
 * convention) into the zero-based `KeypointEdge` pairs used by supervision-js.
 */
export function convertOneBasedEdges(edges, vertexCount) {
  return edges.map(([from, to]) => {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < 1 ||
      from > vertexCount ||
      to > vertexCount
    ) {
      throw new Error(
        `Skeleton edge [${from}, ${to}] is outside the one-based vertex range 1..${vertexCount}.`,
      );
    }

    return [from - 1, to - 1];
  });
}

/** Converts a model `xyxy` corner box into a center-based media-pixel rect. */
export function xyxyToCenterRect([x1, y1, x2, y2]) {
  const width = x2 - x1;
  const height = y2 - y1;

  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }

  return {
    height: round(height, 1),
    width: round(width, 1),
    x: round(x1 + width / 2, 1),
    y: round(y1 + height / 2, 1),
  };
}

/**
 * Deterministically simplifies a closed polygon contour.
 *
 * Runs Ramer-Douglas-Peucker with `tolerance`, then keeps growing the
 * tolerance until the ring fits inside `maxPoints`. A final uniform decimation
 * guarantees the bound even for pathological zig-zag contours, so a hostile
 * mask can never produce an unbounded vector payload.
 */
export function simplifyPolygonPoints(points, options = {}) {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POLYGON_POINTS;
  const baseTolerance = options.tolerance ?? DEFAULT_POLYGON_TOLERANCE;

  if (!Number.isInteger(maxPoints) || maxPoints < 3) {
    throw new Error("maxPoints must be an integer of at least 3.");
  }

  let simplified = dedupeConsecutivePoints(
    points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
  );

  for (
    let tolerance = baseTolerance;
    simplified.length > maxPoints;
    tolerance *= 2
  ) {
    const next = dedupeConsecutivePoints(
      simplifyClosedRing(simplified, tolerance),
    );

    if (next.length < 3 || next.length >= simplified.length) {
      break;
    }

    simplified = next;
  }

  if (simplified.length > maxPoints) {
    simplified = decimateToCount(simplified, maxPoints);
  }

  return simplified.length < 3 ? undefined : simplified;
}

/**
 * Normalizes one raw pose detection (model-native values) into a
 * supervision-js `Detection` with keypoint geometry.
 */
export function normalizePoseDetection(rawDetection, options) {
  const {
    frameIndex,
    personIndex,
    className = "person",
    sourceId = "pose",
    zIndexBase = 100,
    visibleConfidence = DEFAULT_KEYPOINT_VISIBLE_CONFIDENCE,
    edgesOneBased = COCO_SKELETON_EDGES_ONE_BASED,
  } = options;
  const rect = xyxyToCenterRect(rawDetection.xyxy);

  if (!rect) {
    return undefined;
  }

  const rawPoints = rawDetection.keypoints?.xy ?? [];
  const confidences = rawDetection.keypoints?.confidence ?? [];
  const points = rawPoints.map(([x, y]) => ({
    x: round(x, 1),
    y: round(y, 1),
  }));
  const visibility = points.map((_, index) =>
    (confidences[index] ?? 0) >= visibleConfidence
      ? KEYPOINT_VISIBILITY_VISIBLE
      : KEYPOINT_VISIBILITY_NOT_LABELED,
  );

  if (!visibility.includes(KEYPOINT_VISIBILITY_VISIBLE)) {
    return undefined;
  }

  const edges = convertOneBasedEdges(edgesOneBased, points.length).filter(
    ([from, to]) =>
      visibility[from] === KEYPOINT_VISIBILITY_VISIBLE &&
      visibility[to] === KEYPOINT_VISIBILITY_VISIBLE,
  );

  return {
    className,
    confidence: rawDetection.confidence,
    id: `pose:${frameIndex}:${personIndex}`,
    keypoints: { edges, points, visibility },
    rect,
    sourceId,
    zIndex: zIndexBase + personIndex,
  };
}

/**
 * Attaches pose geometry to class detections using deterministic one-to-one
 * rectangle IoU matching. Standalone pose detections are intentionally not
 * returned: the class detection remains authoritative for identity, label,
 * confidence, box, mask, and polygon.
 */
export function attachPoseKeypointsToDetections(
  detections,
  poseDetections,
  options,
) {
  const minimumIou = options.minimumIou ?? DEFAULT_POSE_MATCH_IOU;
  const targetClassNames = new Set(options.targetClassNames);

  if (!(minimumIou >= 0 && minimumIou <= 1)) {
    throw new Error("minimumIou must be between 0 and 1.");
  }

  const targetIndexes = detections.flatMap((detection, detectionIndex) =>
    detection.rect && targetClassNames.has(detection.className)
      ? [detectionIndex]
      : [],
  );
  const candidates = targetIndexes.flatMap((detectionIndex) =>
    poseDetections.flatMap((poseDetection, poseIndex) => {
      if (!poseDetection.rect || !poseDetection.keypoints) return [];

      const score = rectIntersectionOverUnion(
        detections[detectionIndex].rect,
        poseDetection.rect,
      );

      return score >= minimumIou ? [{ detectionIndex, poseIndex, score }] : [];
    }),
  );

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.detectionIndex - right.detectionIndex ||
      left.poseIndex - right.poseIndex,
  );

  const matches = new Map();
  const matchedPoseIndexes = new Set();

  for (const candidate of candidates) {
    if (
      matches.has(candidate.detectionIndex) ||
      matchedPoseIndexes.has(candidate.poseIndex)
    ) {
      continue;
    }

    matches.set(candidate.detectionIndex, candidate);
    matchedPoseIndexes.add(candidate.poseIndex);
  }

  return {
    detections: detections.map((detection, detectionIndex) => {
      const match = matches.get(detectionIndex);

      if (!match) return detection;

      const poseDetection = poseDetections[match.poseIndex];

      return {
        ...detection,
        keypoints: poseDetection.keypoints,
        metadata: {
          ...detection.metadata,
          poseDetection: {
            confidence: poseDetection.confidence,
            id: poseDetection.id,
            matchIou: round(match.score, 4),
            sourceId: poseDetection.sourceId,
          },
        },
      };
    }),
    matchedPoseCount: matchedPoseIndexes.size,
    unmatchedPoseCount: poseDetections.length - matchedPoseIndexes.size,
    unmatchedTargetCount: targetIndexes.length - matches.size,
  };
}

/** Counts detection geometry by type for fixture summaries. */
export function summarizeFrameGeometry(frames) {
  const geometry = {
    boxDetectionCount: 0,
    keypointDetectionCount: 0,
    maskDetectionCount: 0,
    polygonDetectionCount: 0,
    polylineDetectionCount: 0,
  };

  for (const frame of frames) {
    for (const detection of frame.detections) {
      geometry.boxDetectionCount += detection.rect ? 1 : 0;
      geometry.keypointDetectionCount += detection.keypoints ? 1 : 0;
      geometry.maskDetectionCount += detection.mask ? 1 : 0;
      geometry.polygonDetectionCount += detection.polygon ? 1 : 0;
      geometry.polylineDetectionCount += detection.polyline ? 1 : 0;
    }
  }

  return geometry;
}

function rectIntersectionOverUnion(left, right) {
  const leftX1 = left.x - left.width / 2;
  const leftY1 = left.y - left.height / 2;
  const leftX2 = left.x + left.width / 2;
  const leftY2 = left.y + left.height / 2;
  const rightX1 = right.x - right.width / 2;
  const rightY1 = right.y - right.height / 2;
  const rightX2 = right.x + right.width / 2;
  const rightY2 = right.y + right.height / 2;
  const intersectionWidth = Math.max(
    0,
    Math.min(leftX2, rightX2) - Math.max(leftX1, rightX1),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftY2, rightY2) - Math.max(leftY1, rightY1),
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea =
    left.width * left.height + right.width * right.height - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

function simplifyClosedRing(points, tolerance) {
  if (points.length <= 3) {
    return points;
  }

  // Split the ring at its two mutually furthest anchor points so RDP keeps
  // the overall silhouette instead of collapsing a closed loop to a segment.
  const anchorIndex = findFurthestPointIndex(points, points[0]);
  const firstArc = points.slice(0, anchorIndex + 1);
  const secondArc = [...points.slice(anchorIndex), points[0]];
  const simplifiedFirst = simplifyOpenPath(firstArc, tolerance);
  const simplifiedSecond = simplifyOpenPath(secondArc, tolerance);

  return [...simplifiedFirst.slice(0, -1), ...simplifiedSecond.slice(0, -1)];
}

function simplifyOpenPath(points, tolerance) {
  if (points.length <= 2) {
    return points;
  }

  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const ranges = [[0, points.length - 1]];

  while (ranges.length > 0) {
    const [startIndex, endIndex] = ranges.pop();
    let maxDistance = -1;
    let maxIndex = -1;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distanceToSegment(
        points[index],
        points[startIndex],
        points[endIndex],
      );

      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }

    if (maxDistance > tolerance) {
      keep[maxIndex] = true;
      ranges.push([startIndex, maxIndex], [maxIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        );
  const projectedX = start.x + t * dx;
  const projectedY = start.y + t * dy;

  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function findFurthestPointIndex(points, origin) {
  let maxDistance = -1;
  let maxIndex = 1;

  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.hypot(
      points[index].x - origin.x,
      points[index].y - origin.y,
    );

    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = index;
    }
  }

  return maxIndex;
}

function decimateToCount(points, maxPoints) {
  const step = points.length / maxPoints;

  return Array.from(
    { length: maxPoints },
    (_, index) => points[Math.floor(index * step)],
  );
}

function dedupeConsecutivePoints(points) {
  const deduped = [];

  for (const point of points) {
    const previous = deduped[deduped.length - 1];

    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      deduped.push(point);
    }
  }

  const first = deduped[0];
  const last = deduped[deduped.length - 1];

  if (deduped.length > 1 && first.x === last.x && first.y === last.y) {
    deduped.pop();
  }

  return deduped;
}

function round(value, decimals) {
  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;
}
