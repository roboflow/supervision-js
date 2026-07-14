import type { Detection, Point, Rect, TopLeftRect } from "#types/detections";

export function centerRectToTopLeftRect(rect: Rect): TopLeftRect {
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x - rect.width / 2,
    y: rect.y - rect.height / 2,
  };
}

export function topLeftRectToCenterRect(rect: TopLeftRect): Rect {
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function getPointsRect(points: readonly Point[]): Rect | undefined {
  if (points.length === 0) {
    return undefined;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}

export function getDetectionRect(detection: Detection): Rect | undefined {
  return (
    detection.rect ??
    getPointsRect(detection.polygon?.points ?? []) ??
    getPointsRect(detection.polyline?.points ?? []) ??
    getPointsRect(detection.keypoints?.points ?? [])
  );
}

export function containsPoint(rect: Rect, point: Point, padding = 0): boolean {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;

  return (
    point.x >= rect.x - halfWidth - padding &&
    point.x <= rect.x + halfWidth + padding &&
    point.y >= rect.y - halfHeight - padding &&
    point.y <= rect.y + halfHeight + padding
  );
}

export function pointInPolygon(
  point: Point,
  polygon: readonly Point[],
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;

  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex]!;
    const previous = polygon[previousIndex]!;
    const crossesRay =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;

    if (crossesRay) {
      inside = !inside;
    }
  }

  return inside;
}

export function distanceToSegment(
  point: Point,
  start: Point,
  end: Point,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  const closestX = start.x + projection * deltaX;
  const closestY = start.y + projection * deltaY;

  return Math.hypot(point.x - closestX, point.y - closestY);
}

export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) {
    return 0;
  }

  let twiceArea = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(twiceArea) / 2;
}

export function rectArea(rect: Rect | undefined): number {
  return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
}
