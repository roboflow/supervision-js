import type { Point } from "#types/detections";
import { MarkerShape, MarkerSizeSpace } from "#types/shape-style";

const DEFAULT_ELLIPSE_SEGMENT_COUNT = 48;
const FULL_TURN = Math.PI * 2;
const GEOMETRY_EPSILON = 1e-9;
const MIN_ELLIPSE_SEGMENT_COUNT = 4;
const MAX_ELLIPSE_SEGMENT_COUNT = 512;

export interface EllipseGeometry {
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation?: number;
  readonly startAngle?: number;
  readonly endAngle?: number;
}

export interface MarkerGeometryInput {
  readonly center: Point;
  readonly shape: MarkerShape;
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
  readonly rotation?: number;
}

export interface SampledShapePath {
  readonly closed: boolean;
  readonly points: readonly Point[];
}

/**
 * Samples an ellipse or elliptical arc into a deterministic polyline so every
 * backend rasterizes the same structural geometry, including dashed strokes.
 *
 * A closed ellipse returns `segmentCount` points without repeating the first
 * point; an open arc returns `segmentCount + 1` points including both
 * endpoints.
 */
export function sampleEllipseArc(
  ellipse: EllipseGeometry,
  segmentCount = DEFAULT_ELLIPSE_SEGMENT_COUNT,
): SampledShapePath {
  validateEllipseGeometry(ellipse);
  assertIntegerAtLeast(segmentCount, MIN_ELLIPSE_SEGMENT_COUNT, "segmentCount");

  const rotation = ellipse.rotation ?? 0;
  const startAngle = ellipse.startAngle ?? 0;
  const endAngle = ellipse.endAngle ?? startAngle + FULL_TURN;
  const range = endAngle - startAngle;
  const closed = ellipse.startAngle === undefined;
  const pointCount = closed ? segmentCount : segmentCount + 1;
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const points: Point[] = [];

  for (let index = 0; index < pointCount; index += 1) {
    const angle = startAngle + (range * index) / segmentCount;
    const localX = Math.cos(angle) * ellipse.radiusX;
    const localY = Math.sin(angle) * ellipse.radiusY;

    points.push({
      x: ellipse.center.x + localX * cosRotation - localY * sinRotation,
      y: ellipse.center.y + localX * sinRotation + localY * cosRotation,
    });
  }

  return { closed, points };
}

/**
 * Chooses a bounded segment count from the ellipse's on-screen radius. The
 * result targets sub-pixel chord error without making tiny markers expensive.
 */
export function resolveEllipseSegmentCount(
  ellipse: EllipseGeometry,
  viewportScale = 1,
  maxErrorPixels = 0.5,
): number {
  validateEllipseGeometry(ellipse);
  assertPositiveFinite(viewportScale, "viewportScale");
  assertPositiveFinite(maxErrorPixels, "maxErrorPixels");

  const screenRadius =
    Math.max(ellipse.radiusX, ellipse.radiusY) * viewportScale;
  assertPositiveFinite(screenRadius, "screenRadius");
  const clampedError = Math.min(maxErrorPixels, screenRadius);
  const maxStep =
    clampedError === screenRadius
      ? Math.PI / 2
      : 2 * Math.acos(1 - clampedError / screenRadius);
  const startAngle = ellipse.startAngle ?? 0;
  const endAngle = ellipse.endAngle ?? startAngle + FULL_TURN;
  const arcLength = Math.abs(endAngle - startAngle);
  const segmentCount = Math.ceil(arcLength / maxStep);

  return Math.min(
    MAX_ELLIPSE_SEGMENT_COUNT,
    Math.max(MIN_ELLIPSE_SEGMENT_COUNT, segmentCount),
  );
}

export type MarkerGeometry =
  | {
      readonly kind: "circle";
      readonly center: Point;
      readonly radius: number;
    }
  | {
      readonly kind: "subpaths";
      readonly closed: boolean;
      readonly subpaths: readonly (readonly Point[])[];
    };

/**
 * Resolves a marker instruction into media-space geometry. Screen-space sizes
 * are divided by the viewport scale, matching stroke-width semantics.
 */
export function resolveMarkerGeometry(
  marker: MarkerGeometryInput,
  viewportScale = 1,
): MarkerGeometry {
  assertFinitePoint(marker.center, "center");
  assertPositiveFinite(marker.size, "size");
  assertPositiveFinite(viewportScale, "viewportScale");
  if (marker.rotation !== undefined) {
    assertFinite(marker.rotation, "rotation");
  }

  const size =
    marker.sizeSpace === MarkerSizeSpace.Screen
      ? marker.size / viewportScale
      : marker.size;
  const radius = size / 2;
  const rotation = marker.rotation ?? 0;

  if (marker.shape === MarkerShape.Circle) {
    return { center: marker.center, kind: "circle", radius };
  }

  if (marker.shape === MarkerShape.Cross) {
    return {
      closed: false,
      kind: "subpaths",
      subpaths: [
        [
          rotatePoint(marker.center, -radius, -radius, rotation),
          rotatePoint(marker.center, radius, radius, rotation),
        ],
        [
          rotatePoint(marker.center, radius, -radius, rotation),
          rotatePoint(marker.center, -radius, radius, rotation),
        ],
      ],
    };
  }

  if (marker.shape === MarkerShape.Square) {
    return {
      closed: true,
      kind: "subpaths",
      subpaths: [
        [
          rotatePoint(marker.center, -radius, -radius, rotation),
          rotatePoint(marker.center, radius, -radius, rotation),
          rotatePoint(marker.center, radius, radius, rotation),
          rotatePoint(marker.center, -radius, radius, rotation),
        ],
      ],
    };
  }

  // Triangle: equilateral, inscribed in the marker circle, pointing toward
  // positive y at rotation 0.
  const baseOffsetY = -radius / 2;
  const baseOffsetX = radius * (Math.sqrt(3) / 2);

  return {
    closed: true,
    kind: "subpaths",
    subpaths: [
      [
        rotatePoint(marker.center, 0, radius, rotation),
        rotatePoint(marker.center, baseOffsetX, baseOffsetY, rotation),
        rotatePoint(marker.center, -baseOffsetX, baseOffsetY, rotation),
      ],
    ],
  };
}

function validateEllipseGeometry(ellipse: EllipseGeometry) {
  assertFinitePoint(ellipse.center, "center");
  assertPositiveFinite(ellipse.radiusX, "radiusX");
  assertPositiveFinite(ellipse.radiusY, "radiusY");
  if (ellipse.rotation !== undefined) {
    assertFinite(ellipse.rotation, "rotation");
  }

  const hasStart = ellipse.startAngle !== undefined;
  const hasEnd = ellipse.endAngle !== undefined;
  if (hasStart !== hasEnd) {
    throw new RangeError("startAngle and endAngle must be provided together");
  }

  if (hasStart && hasEnd) {
    assertFinite(ellipse.startAngle!, "startAngle");
    assertFinite(ellipse.endAngle!, "endAngle");
    const range = Math.abs(ellipse.endAngle! - ellipse.startAngle!);
    if (range <= GEOMETRY_EPSILON || range >= FULL_TURN - GEOMETRY_EPSILON) {
      throw new RangeError(
        "ellipse arc range must be greater than 0 and less than one full turn",
      );
    }
  }
}

function assertFinitePoint(point: Point, name: string) {
  assertFinite(point.x, `${name}.x`);
  assertFinite(point.y, `${name}.y`);
}

function assertFinite(value: number, name: string): asserts value is number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function assertPositiveFinite(
  value: number,
  name: string,
): asserts value is number {
  assertFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than 0`);
  }
}

function assertIntegerAtLeast(value: number, minimum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${minimum}`);
  }
}

function rotatePoint(
  center: Point,
  offsetX: number,
  offsetY: number,
  rotation: number,
): Point {
  if (rotation === 0) {
    return { x: center.x + offsetX, y: center.y + offsetY };
  }

  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);

  return {
    x: center.x + offsetX * cosRotation - offsetY * sinRotation,
    y: center.y + offsetX * sinRotation + offsetY * cosRotation,
  };
}
