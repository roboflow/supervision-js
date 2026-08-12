import type { Point } from "#types/detections";
import {
  MarkerShape,
  MarkerSizeSpace,
  type EllipseShapeInstruction,
  type MarkerShapeInstruction,
} from "#types/shape-style";

const DEFAULT_ELLIPSE_SEGMENT_COUNT = 48;
const FULL_TURN = Math.PI * 2;

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
  ellipse: Omit<EllipseShapeInstruction, "kind" | "fill" | "stroke">,
  segmentCount = DEFAULT_ELLIPSE_SEGMENT_COUNT,
): SampledShapePath {
  const rotation = ellipse.rotation ?? 0;
  const startAngle = ellipse.startAngle ?? 0;
  const endAngle = ellipse.endAngle ?? startAngle + FULL_TURN;
  const range = endAngle - startAngle;
  const closed = Math.abs(Math.abs(range) - FULL_TURN) < 1e-9;
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
  marker: Omit<MarkerShapeInstruction, "kind" | "fill" | "stroke">,
  viewportScale = 1,
): MarkerGeometry {
  const size =
    marker.sizeSpace === MarkerSizeSpace.Screen
      ? marker.size / Math.max(viewportScale, Number.EPSILON)
      : marker.size;
  const radius = size / 2;
  const rotation = marker.rotation ?? 0;

  if (marker.shape === MarkerShape.Circle) {
    return { center: marker.point, kind: "circle", radius };
  }

  if (marker.shape === MarkerShape.Cross) {
    return {
      closed: false,
      kind: "subpaths",
      subpaths: [
        [
          rotatePoint(marker.point, -radius, -radius, rotation),
          rotatePoint(marker.point, radius, radius, rotation),
        ],
        [
          rotatePoint(marker.point, radius, -radius, rotation),
          rotatePoint(marker.point, -radius, radius, rotation),
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
          rotatePoint(marker.point, -radius, -radius, rotation),
          rotatePoint(marker.point, radius, -radius, rotation),
          rotatePoint(marker.point, radius, radius, rotation),
          rotatePoint(marker.point, -radius, radius, rotation),
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
        rotatePoint(marker.point, 0, radius, rotation),
        rotatePoint(marker.point, baseOffsetX, baseOffsetY, rotation),
        rotatePoint(marker.point, -baseOffsetX, baseOffsetY, rotation),
      ],
    ],
  };
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
