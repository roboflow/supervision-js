import type {
  Detection,
  DetectionMask,
  Point,
  PolygonGeometry,
  Rect,
} from "#types/detections";
import { decodeCompressedRleMask } from "#utils/detection-frames";
import {
  computeDetectionMaskRect,
  encodeBinaryMask,
  extractMaskContour,
} from "#utils/detection-masks";
import { centerRectToTopLeftRect, getPointsRect } from "#utils/geometry";

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

export function rectToPolygon(rect: Rect): PolygonGeometry {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;

  return {
    points: [
      { x: rect.x - halfWidth, y: rect.y - halfHeight },
      { x: rect.x + halfWidth, y: rect.y - halfHeight },
      { x: rect.x + halfWidth, y: rect.y + halfHeight },
      { x: rect.x - halfWidth, y: rect.y + halfHeight },
    ],
  };
}

export function polygonToRect(polygon: PolygonGeometry): Rect | undefined {
  return getPointsRect(polygon.points);
}

export function rasterizeRectToMask(
  rect: Rect,
  dimensions: MediaDimensions,
): Uint8Array {
  const data = createEmptyMask(dimensions);
  const topLeft = centerRectToTopLeftRect(rect);
  const left = Math.max(0, Math.round(topLeft.x));
  const top = Math.max(0, Math.round(topLeft.y));
  const right = Math.min(
    dimensions.width - 1,
    Math.round(rect.x + rect.width / 2),
  );
  const bottom = Math.min(
    dimensions.height - 1,
    Math.round(rect.y + rect.height / 2),
  );

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      data[y * dimensions.width + x] = 1;
    }
  }

  return data;
}

export function rasterizePolygonToMask(
  points: readonly Point[],
  dimensions: MediaDimensions,
): Uint8Array {
  const data = createEmptyMask(dimensions);

  if (points.length < 3) {
    return data;
  }

  const bounds = centerRectToTopLeftRect(getPointsRect(points)!);
  const startY = Math.max(0, Math.floor(bounds.y));
  const endY = Math.min(
    dimensions.height - 1,
    Math.ceil(bounds.y + bounds.height),
  );

  for (let y = startY; y <= endY; y += 1) {
    const scanY = y + 0.5;
    const intersections: number[] = [];

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;

      if (
        (current.y <= scanY && next.y > scanY) ||
        (next.y <= scanY && current.y > scanY)
      ) {
        const ratio = (scanY - current.y) / (next.y - current.y);
        intersections.push(current.x + ratio * (next.x - current.x));
      }
    }

    intersections.sort((left, right) => left - right);

    for (let index = 0; index < intersections.length - 1; index += 2) {
      const left = Math.max(0, Math.ceil(intersections[index]!));
      const right = Math.min(
        dimensions.width - 1,
        Math.floor(intersections[index + 1]!),
      );

      for (let x = left; x <= right; x += 1) {
        data[y * dimensions.width + x] = 1;
      }
    }
  }

  return data;
}

export function convertDetectionBoxToPolygon(detection: Detection): Detection {
  return detection.rect
    ? replaceGeometry(detection, { polygon: rectToPolygon(detection.rect) })
    : detection;
}

export function convertDetectionPolygonToBox(detection: Detection): Detection {
  const rect = detection.polygon ? polygonToRect(detection.polygon) : undefined;

  return rect ? replaceGeometry(detection, { rect }) : detection;
}

export function convertDetectionMaskToBox(detection: Detection): Detection {
  const rect = detection.mask
    ? computeDetectionMaskRect(detection.mask)
    : undefined;

  return rect ? replaceGeometry(detection, { rect }) : detection;
}

export function convertDetectionMaskToPolygon(detection: Detection): Detection {
  if (!detection.mask) {
    return detection;
  }

  const decoded = decodeCompressedRleMask(detection.mask);
  const contour = extractMaskContour(
    decoded.data,
    decoded.width,
    decoded.height,
  );
  const fallbackRect = computeDetectionMaskRect(detection.mask);
  const polygon =
    contour && contour.length >= 3
      ? { points: contour }
      : fallbackRect
        ? rectToPolygon(fallbackRect)
        : undefined;

  return polygon ? replaceGeometry(detection, { polygon }) : detection;
}

export function convertDetectionBoxToMask(
  detection: Detection,
  dimensions: MediaDimensions,
): Detection {
  if (!detection.rect) {
    return detection;
  }

  const mask = encodeBinaryMask(
    rasterizeRectToMask(detection.rect, dimensions),
    dimensions.width,
    dimensions.height,
  );

  return replaceGeometry(detection, { mask });
}

export function convertDetectionPolygonToMask(
  detection: Detection,
  dimensions: MediaDimensions,
): Detection {
  if (!detection.polygon) {
    return detection;
  }

  const mask = encodeBinaryMask(
    rasterizePolygonToMask(detection.polygon.points, dimensions),
    dimensions.width,
    dimensions.height,
  );

  return replaceGeometry(detection, { mask });
}

export function mergeDetectionMasks(
  detections: readonly Detection[],
): Detection | null {
  if (detections.length < 2 || detections.some(({ mask }) => !mask)) {
    return null;
  }

  const first = detections[0]!;

  if (detections.some((detection) => detection.className !== first.className)) {
    return null;
  }

  const masks = detections.map(({ mask }) => decodeCompressedRleMask(mask!));
  const width = masks[0]!.width;
  const height = masks[0]!.height;

  if (masks.some((mask) => mask.width !== width || mask.height !== height)) {
    throw new Error("Merged detection masks must have matching dimensions.");
  }

  const data = new Uint8Array(width * height);

  for (const mask of masks) {
    for (let index = 0; index < data.length; index += 1) {
      data[index] ||= mask.data[index] ?? 0;
    }
  }

  return replaceGeometry(first, {
    mask: encodeBinaryMask(data, width, height),
  });
}

/**
 * Groups polygon detections by class and returns one union bounding-box
 * detection per class. This intentionally converts the output to rectangles.
 */
export function mergeDetectionPolygonsByClass(
  detections: readonly Detection[],
  options: {
    readonly createId?: (
      className: string | undefined,
      groupIndex: number,
    ) => string | number;
  } = {},
): Detection[] {
  const groups = new Map<string | undefined, Detection[]>();

  for (const detection of detections) {
    if (!detection.polygon) {
      continue;
    }

    const group = groups.get(detection.className) ?? [];
    group.push(detection);
    groups.set(detection.className, group);
  }

  return [...groups.entries()].flatMap(([className, group], groupIndex) => {
    const points = group.flatMap((detection) => detection.polygon!.points);
    const rect = getPointsRect(points);

    if (!rect) {
      return [];
    }

    const first = group[0]!;
    const id = options.createId?.(className, groupIndex) ?? first.id;

    return [
      replaceGeometry(
        {
          ...first,
          id,
        },
        { rect },
      ),
    ];
  });
}

function createEmptyMask(dimensions: MediaDimensions) {
  if (
    !Number.isInteger(dimensions.width) ||
    dimensions.width <= 0 ||
    !Number.isInteger(dimensions.height) ||
    dimensions.height <= 0
  ) {
    throw new Error("Media dimensions must be positive integers.");
  }

  return new Uint8Array(dimensions.width * dimensions.height);
}

function replaceGeometry(
  detection: Detection,
  geometry: {
    readonly rect?: Rect;
    readonly mask?: DetectionMask;
    readonly polygon?: PolygonGeometry;
  },
): Detection {
  return {
    ...detection,
    keypoints: undefined,
    mask: geometry.mask,
    polygon: geometry.polygon,
    polyline: undefined,
    rect: geometry.rect,
  };
}
