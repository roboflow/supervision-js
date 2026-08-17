import {
  AnnotationHandleKind,
  type AnnotationHandleDefinition,
} from "#types/editing";
import {
  type Detection,
  KeypointVisibility,
  type Point,
  type Rect,
} from "#types/detections";
import { distanceToSegment } from "#utils/geometry";

const HANDLE_RADIUS = 6;
const ADD_HANDLE_RADIUS = 3.6;
const HANDLE_HIT_SIZE = 16;
const KEYPOINT_RESIZE_HANDLE_OUTSET = 12;

export function getAnnotationHandles(
  detection: Detection,
  viewportScale = 1,
): readonly AnnotationHandleDefinition[] {
  if (detection.locked || detection.mask) return [];
  const radius = HANDLE_RADIUS / viewportScale;
  const hitSize = HANDLE_HIT_SIZE / viewportScale;

  if (detection.polygon)
    return getPathHandles(detection.polygon.points, true, radius, hitSize);
  if (detection.polyline)
    return getPathHandles(detection.polyline.points, false, radius, hitSize);
  if (detection.keypoints) {
    const keypointHandles = detection.keypoints.points.flatMap(
      (point, geometryIndex) =>
        detection.keypoints?.visibility?.[geometryIndex] ===
        KeypointVisibility.NotLabeled
          ? []
          : [
              {
                cursor: "move",
                geometryIndex,
                hitSize,
                id: `kp-${geometryIndex}`,
                kind: AnnotationHandleKind.Keypoint,
                point,
                radius,
              },
            ],
    );
    if (!detection.rect) return keypointHandles;

    // Keep whole-skeleton resize handles outside the tight keypoint bounds so
    // an extreme keypoint remains independently draggable.
    return [
      ...getBoxHandles(
        detection.rect,
        radius,
        hitSize,
        KEYPOINT_RESIZE_HANDLE_OUTSET / viewportScale,
      ),
      ...keypointHandles,
    ];
  }
  if (detection.rect) return getBoxHandles(detection.rect, radius, hitSize);
  return [];
}

export function pickAnnotationHandle(
  handles: readonly AnnotationHandleDefinition[],
  point: Point,
) {
  return [...handles]
    .reverse()
    .find(
      (handle) =>
        Math.abs(point.x - handle.point.x) <= handle.hitSize / 2 &&
        Math.abs(point.y - handle.point.y) <= handle.hitSize / 2,
    );
}

export function applyAnnotationHandleDrag(
  detection: Detection,
  handle: AnnotationHandleDefinition,
  point: Point,
): Detection {
  if (detection.rect && handle.kind === AnnotationHandleKind.Resize) {
    const resizePoint = resizeBoundaryPoint(detection.rect, handle, point);
    const rect = resizeRect(detection.rect, handle.id, resizePoint);
    if (!detection.keypoints) return { ...detection, rect };

    return {
      ...detection,
      keypoints: {
        ...detection.keypoints,
        points: scalePointsBetweenRects(
          detection.keypoints.points,
          detection.rect,
          rect,
        ),
      },
      rect,
    };
  }

  if (
    handle.kind === AnnotationHandleKind.AddVertex &&
    handle.edgeIndex !== undefined
  ) {
    const key = detection.polygon ? "polygon" : "polyline";
    const geometry = detection[key];
    if (!geometry) return detection;
    const points = [...geometry.points];
    points.splice(handle.edgeIndex + 1, 0, point);
    return { ...detection, [key]: { points } };
  }

  if (handle.geometryIndex === undefined) return detection;
  if (detection.polygon)
    return replacePathPoint(detection, "polygon", handle.geometryIndex, point);
  if (detection.polyline)
    return replacePathPoint(detection, "polyline", handle.geometryIndex, point);
  if (detection.keypoints) {
    const points = [...detection.keypoints.points];
    points[handle.geometryIndex] = point;
    return { ...detection, keypoints: { ...detection.keypoints, points } };
  }
  return detection;
}

export function deleteAnnotationVertex(
  detection: Detection,
  vertexIndex: number,
): Detection | null {
  const geometry = detection.polygon ?? detection.polyline;
  const minimum = detection.polygon ? 3 : 2;
  if (!geometry || geometry.points.length <= minimum) return null;
  const points = geometry.points.filter((_, index) => index !== vertexIndex);
  return detection.polygon
    ? { ...detection, polygon: { points } }
    : { ...detection, polyline: { points } };
}

export function offsetDetection(
  detection: Detection,
  dx: number,
  dy: number,
): Detection {
  const offsetPoint = ({ x, y }: Point) => ({ x: x + dx, y: y + dy });
  return {
    ...detection,
    ...(detection.rect
      ? {
          rect: {
            ...detection.rect,
            x: detection.rect.x + dx,
            y: detection.rect.y + dy,
          },
        }
      : {}),
    ...(detection.polygon
      ? { polygon: { points: detection.polygon.points.map(offsetPoint) } }
      : {}),
    ...(detection.polyline
      ? { polyline: { points: detection.polyline.points.map(offsetPoint) } }
      : {}),
    ...(detection.keypoints
      ? {
          keypoints: {
            ...detection.keypoints,
            points: detection.keypoints.points.map(offsetPoint),
          },
        }
      : {}),
  };
}

function getBoxHandles(
  rect: Rect,
  radius: number,
  hitSize: number,
  outset = 0,
) {
  const left = rect.x - rect.width / 2 - outset;
  const right = rect.x + rect.width / 2 + outset;
  const top = rect.y - rect.height / 2 - outset;
  const bottom = rect.y + rect.height / 2 + outset;
  const definitions: readonly [string, Point, string][] = [
    ["nw", { x: left, y: top }, "nwse-resize"],
    ["n", { x: rect.x, y: top }, "ns-resize"],
    ["ne", { x: right, y: top }, "nesw-resize"],
    ["e", { x: right, y: rect.y }, "ew-resize"],
    ["se", { x: right, y: bottom }, "nwse-resize"],
    ["s", { x: rect.x, y: bottom }, "ns-resize"],
    ["sw", { x: left, y: bottom }, "nesw-resize"],
    ["w", { x: left, y: rect.y }, "ew-resize"],
  ];
  return definitions.map(([id, point, cursor]) => ({
    cursor,
    hitSize,
    id,
    kind: AnnotationHandleKind.Resize,
    point,
    radius,
  }));
}

function resizeBoundaryPoint(
  rect: Rect,
  handle: AnnotationHandleDefinition,
  point: Point,
): Point {
  const left = rect.x - rect.width / 2;
  const right = rect.x + rect.width / 2;
  const top = rect.y - rect.height / 2;
  const bottom = rect.y + rect.height / 2;
  const boundary = {
    x: handle.id.includes("w")
      ? left
      : handle.id.includes("e")
        ? right
        : rect.x,
    y: handle.id.includes("n")
      ? top
      : handle.id.includes("s")
        ? bottom
        : rect.y,
  };
  return {
    x: point.x + boundary.x - handle.point.x,
    y: point.y + boundary.y - handle.point.y,
  };
}

function scalePointsBetweenRects(
  points: readonly Point[],
  from: Rect,
  to: Rect,
): Point[] {
  const scaleX = from.width > 0 ? to.width / from.width : 1;
  const scaleY = from.height > 0 ? to.height / from.height : 1;
  return points.map((point) => ({
    x: to.x + (point.x - from.x) * scaleX,
    y: to.y + (point.y - from.y) * scaleY,
  }));
}

function getPathHandles(
  points: readonly Point[],
  closed: boolean,
  radius: number,
  hitSize: number,
) {
  const handles: AnnotationHandleDefinition[] = points.map(
    (point, geometryIndex) => ({
      cursor: "move",
      geometryIndex,
      hitSize,
      id: `vertex-${geometryIndex}`,
      kind: AnnotationHandleKind.Vertex,
      point,
      radius,
    }),
  );
  const edgeCount = closed ? points.length : Math.max(0, points.length - 1);
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    const from = points[edgeIndex]!;
    const to = points[(edgeIndex + 1) % points.length]!;
    handles.push({
      cursor: "copy",
      edgeIndex,
      hitSize,
      id: `add-${edgeIndex}`,
      kind: AnnotationHandleKind.AddVertex,
      point: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      radius: ADD_HANDLE_RADIUS / (HANDLE_RADIUS / radius),
    });
  }
  return handles;
}

function resizeRect(rect: Rect, handle: string, point: Point): Rect {
  let left = rect.x - rect.width / 2;
  let right = rect.x + rect.width / 2;
  let top = rect.y - rect.height / 2;
  let bottom = rect.y + rect.height / 2;
  if (handle.includes("w")) left = Math.min(point.x, right - 5);
  if (handle.includes("e")) right = Math.max(point.x, left + 5);
  if (handle.includes("n")) top = Math.min(point.y, bottom - 5);
  if (handle.includes("s")) bottom = Math.max(point.y, top + 5);
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

function replacePathPoint(
  detection: Detection,
  key: "polygon" | "polyline",
  index: number,
  point: Point,
) {
  const geometry = detection[key]!;
  const points = [...geometry.points];
  points[index] = point;
  return { ...detection, [key]: { points } };
}

/** Finds the closest path segment, useful for contextual vertex insertion. */
export function findClosestAnnotationSegment(
  points: readonly Point[],
  point: Point,
  closed: boolean,
) {
  const count = closed ? points.length : points.length - 1;
  let best: { index: number; distance: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const distance = distanceToSegment(
      point,
      points[index]!,
      points[(index + 1) % points.length]!,
    );
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best;
}
