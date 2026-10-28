import {
  AnnotationHandleKind,
  type AnnotationHandleDefinition,
  type AnnotationHandleOptions,
  type AnnotationRotationHandleOptions,
} from "#types/editing";
import {
  type Detection,
  KeypointVisibility,
  type OrientedBoxGeometry,
  type Point,
  type Rect,
} from "#types/detections";
import { distanceToSegment } from "#utils/geometry";

import {
  createOrientedBoxGeometry,
  getOrientedRectangleGeometry,
} from "#utils/oriented-rectangle";

const HANDLE_RADIUS = 6;
const ADD_HANDLE_RADIUS = 3.6;
const HANDLE_HIT_SIZE = 16;

export function getAnnotationHandles(
  detection: Detection,
  viewportScale = 1,
  options: AnnotationHandleOptions = {},
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
                cursor: "pointer",
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

    // The skeleton's box resizes like any box; keypoints come last so a point
    // sitting on the box edge still wins the hit test.
    return [
      ...getBoxHandles(detection.rect, radius, hitSize),
      ...keypointHandles,
    ];
  }
  if (detection.orientedBox && !detection.rect) {
    const rectangle = getOrientedRectangleGeometry(detection.orientedBox);
    if (rectangle) {
      const placement =
        typeof options.rotationHandle === "function"
          ? options.rotationHandle(detection)
          : options.rotationHandle;
      return getOrientedBoxHandles(rectangle, viewportScale, placement);
    }
  }
  if (detection.rect) return getBoxHandles(detection.rect, radius, hitSize);
  return [];
}

export function pickAnnotationHandle(
  handles: readonly AnnotationHandleDefinition[],
  point: Point,
) {
  let picked: AnnotationHandleDefinition | undefined;
  let pickedDistance = Number.POSITIVE_INFINITY;
  for (const handle of handles) {
    const dx = Math.abs(point.x - handle.point.x);
    const dy = Math.abs(point.y - handle.point.y);
    if (dx > handle.hitSize / 2 || dy > handle.hitSize / 2) continue;
    if (
      handle.kind === AnnotationHandleKind.Rotate &&
      Math.hypot(dx, dy) > handle.hitSize / 2
    )
      continue;
    // Clustered handles (face keypoints, a tiny box's corners) share hit
    // areas; the nearest one is what the pointer is on. Later handles draw on
    // top, so they win exact ties.
    const distance = Math.hypot(dx, dy);
    if (distance <= pickedDistance) {
      picked = handle;
      pickedDistance = distance;
    }
  }
  return picked;
}

export function applyAnnotationHandleDrag(
  detection: Detection,
  handle: AnnotationHandleDefinition,
  point: Point,
  mediaDimensions?: Pick<Rect, "width" | "height">,
  startPoint?: Point,
): Detection {
  if (detection.orientedBox && handle.id.startsWith("obb-")) {
    const rectangle = getOrientedRectangleGeometry(detection.orientedBox);
    if (!rectangle) return detection;
    if (handle.kind === AnnotationHandleKind.Rotate) {
      const start = startPoint ?? handle.point;
      if (Math.hypot(point.x - rectangle.x, point.y - rectangle.y) < 1e-9)
        return detection;
      const delta =
        Math.atan2(point.y - rectangle.y, point.x - rectangle.x) -
        Math.atan2(start.y - rectangle.y, start.x - rectangle.x);
      return {
        ...detection,
        orientedBox: createOrientedBoxGeometry(
          rectangle,
          rectangle.rotation + delta,
        ),
      };
    }
    if (handle.kind === AnnotationHandleKind.Resize) {
      const cos = Math.cos(rectangle.rotation);
      const sin = Math.sin(rectangle.rotation);
      const dx = point.x - rectangle.x;
      const dy = point.y - rectangle.y;
      const px = dx * cos + dy * sin;
      const py = -dx * sin + dy * cos;
      const local = resizeRect(
        { x: 0, y: 0, width: rectangle.width, height: rectangle.height },
        handle.id.slice(4),
        { x: px, y: py },
        undefined,
        1,
      );
      return {
        ...detection,
        orientedBox: createOrientedBoxGeometry(
          {
            x: rectangle.x + local.x * cos - local.y * sin,
            y: rectangle.y + local.x * sin + local.y * cos,
            width: local.width,
            height: local.height,
          },
          rectangle.rotation,
        ),
      };
    }
  }
  if (detection.rect && handle.kind === AnnotationHandleKind.Resize) {
    const rect = resizeRect(detection.rect, handle.id, point, mediaDimensions);
    const boxRelative = detection.keypoints?.boxRelative;
    if (!detection.keypoints || !boxRelative?.some(Boolean)) {
      return { ...detection, rect };
    }
    // Box-relative keypoints (unplaced template points) follow the rect;
    // points the user positioned keep their coordinates.
    const from = detection.rect;
    const scaleX = from.width > 0 ? rect.width / from.width : 1;
    const scaleY = from.height > 0 ? rect.height / from.height : 1;
    return {
      ...detection,
      keypoints: {
        ...detection.keypoints,
        points: detection.keypoints.points.map((keypoint, index) =>
          boxRelative[index]
            ? {
                x: rect.x + (keypoint.x - from.x) * scaleX,
                y: rect.y + (keypoint.y - from.y) * scaleY,
              }
            : keypoint,
        ),
      },
      rect,
    };
  }

  const polygonPoint =
    detection.polygon && mediaDimensions
      ? {
          x: Math.max(0, Math.min(point.x, mediaDimensions.width)),
          y: Math.max(0, Math.min(point.y, mediaDimensions.height)),
        }
      : point;

  if (
    handle.kind === AnnotationHandleKind.AddVertex &&
    handle.edgeIndex !== undefined
  ) {
    const key = detection.polygon ? "polygon" : "polyline";
    const geometry = detection[key];
    if (!geometry) return detection;
    const points = [...geometry.points];
    points.splice(handle.edgeIndex + 1, 0, polygonPoint);
    return { ...detection, [key]: { points } };
  }

  if (handle.geometryIndex === undefined) return detection;
  if (detection.polygon)
    return replacePathPoint(
      detection,
      "polygon",
      handle.geometryIndex,
      polygonPoint,
    );
  if (detection.polyline)
    return replacePathPoint(detection, "polyline", handle.geometryIndex, point);
  if (detection.keypoints) {
    const points = [...detection.keypoints.points];
    points[handle.geometryIndex] = point;
    // A positioned point no longer follows the box.
    const boxRelative = detection.keypoints.boxRelative?.map(
      (relative, index) => relative && index !== handle.geometryIndex,
    );
    return {
      ...detection,
      keypoints: {
        ...detection.keypoints,
        points,
        ...(boxRelative ? { boxRelative } : {}),
      },
    };
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
    ...(detection.orientedBox
      ? {
          orientedBox: {
            points: detection.orientedBox.points.map(
              offsetPoint,
            ) as unknown as OrientedBoxGeometry["points"],
          },
        }
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
    ...(detection.heatmap
      ? {
          heatmap: {
            ...detection.heatmap,
            bounds: {
              ...detection.heatmap.bounds,
              x: detection.heatmap.bounds.x + dx,
              y: detection.heatmap.bounds.y + dy,
            },
          },
        }
      : {}),
  };
}

function getBoxHandles(rect: Rect, radius: number, hitSize: number) {
  const left = rect.x - rect.width / 2;
  const right = rect.x + rect.width / 2;
  const top = rect.y - rect.height / 2;
  const bottom = rect.y + rect.height / 2;
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

function resizeRect(
  rect: Rect,
  handle: string,
  point: Point,
  mediaDimensions?: Pick<Rect, "width" | "height">,
  minimumSize = 5,
): Rect {
  let left = rect.x - rect.width / 2;
  let right = rect.x + rect.width / 2;
  let top = rect.y - rect.height / 2;
  let bottom = rect.y + rect.height / 2;
  if (mediaDimensions) {
    left = Math.max(0, Math.min(left, mediaDimensions.width));
    right = Math.max(0, Math.min(right, mediaDimensions.width));
    top = Math.max(0, Math.min(top, mediaDimensions.height));
    bottom = Math.max(0, Math.min(bottom, mediaDimensions.height));
  }
  if (handle.includes("w"))
    left = resizeEdge(point.x, right, -1, mediaDimensions?.width, minimumSize);
  if (handle.includes("e"))
    right = resizeEdge(point.x, left, 1, mediaDimensions?.width, minimumSize);
  if (handle.includes("n"))
    top = resizeEdge(point.y, bottom, -1, mediaDimensions?.height, minimumSize);
  if (handle.includes("s"))
    bottom = resizeEdge(point.y, top, 1, mediaDimensions?.height, minimumSize);
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

function resizeEdge(
  point: number,
  anchor: number,
  initialDirection: -1 | 1,
  extent?: number,
  minimum = 5,
) {
  let direction = point === anchor ? initialDirection : point < anchor ? -1 : 1;
  if (extent !== undefined) {
    const available = direction === 1 ? extent - anchor : anchor;
    const opposite = direction === 1 ? anchor : extent - anchor;
    // Crossing cannot push the minimum-size box past the media edge. Use the
    // other side of the fixed anchor when it has more room.
    if (available < Math.min(minimum, extent) && opposite > available) {
      direction *= -1;
    }
    minimum = Math.min(minimum, direction === 1 ? extent - anchor : anchor);
  }
  const edge =
    direction === 1
      ? Math.max(point, anchor + minimum)
      : Math.min(point, anchor - minimum);
  return extent === undefined ? edge : Math.max(0, Math.min(edge, extent));
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

function getOrientedBoxHandles(
  rectangle: Rect & { readonly rotation: number },
  scale: number,
  placement: AnnotationRotationHandleOptions = {},
): AnnotationHandleDefinition[] {
  const cos = Math.cos(rectangle.rotation);
  const sin = Math.sin(rectangle.rotation);
  const project = ({ x, y }: Point): Point => ({
    x: rectangle.x + x * cos - y * sin,
    y: rectangle.y + x * sin + y * cos,
  });
  const handles = getBoxHandles(
    { x: 0, y: 0, width: rectangle.width, height: rectangle.height },
    HANDLE_RADIUS / scale,
    HANDLE_HIT_SIZE / scale,
  ).map((handle) => ({
    ...handle,
    cursor: rotatedResizeCursor(handle.cursor, rectangle.rotation),
    id: `obb-${handle.id}`,
    point: project(handle.point),
  }));
  const edge = placement.edgeIndex ?? 0;
  const offset = (placement.offset ?? 24) / scale;
  if (!Number.isFinite(offset) || offset < 0) {
    throw new RangeError(
      "Rotation handle offset must be finite and nonnegative",
    );
  }
  const stemOffset = (placement.stemOffset ?? 0) / scale;
  if (!Number.isFinite(stemOffset) || stemOffset < 0 || stemOffset > offset) {
    throw new RangeError(
      "Rotation handle stem offset must be finite and between 0 and offset",
    );
  }
  const normals: readonly Point[] = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  const normal = normals[edge]!;
  const local = {
    x: (normal.x * rectangle.width) / 2,
    y: (normal.y * rectangle.height) / 2,
  };
  const stemFrom = project({
    x: local.x + normal.x * stemOffset,
    y: local.y + normal.y * stemOffset,
  });
  return [
    ...handles,
    {
      id: "obb-rotate",
      kind: AnnotationHandleKind.Rotate,
      cursor: "grab",
      point: project({
        x: local.x + normal.x * offset,
        y: local.y + normal.y * offset,
      }),
      stemFrom,
      radius: 4 / scale,
      hitSize: 20 / scale,
    },
  ];
}

function rotatedResizeCursor(cursor: string, rotation: number): string {
  const cursors = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  const index = cursors.indexOf(cursor);
  return cursors[
    (((index + Math.round(rotation / (Math.PI / 4))) % 4) + 4) % 4
  ]!;
}
