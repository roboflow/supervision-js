import type {
  Detection,
  DetectionCoordinateSpace,
  DetectionFrame,
  KeypointGeometry,
  OrientedBoxGeometry,
  Point,
  PolygonGeometry,
  PolylineGeometry,
  Rect,
} from "#types/detections";

/**
 * Projects one detection frame from its declared source coordinate space into
 * `target`.
 *
 * Rectangles, polygons, oriented boxes, polylines, and keypoints are scaled.
 * Masks are left untouched because a `DetectionMask` already carries the
 * mask-pixel dimensions its `counts` are encoded against; scaling them here
 * would apply the ratio twice. Frames without `coordinateSpace`, with a
 * degenerate space, or already in the target space are returned unchanged so
 * mixed producers can share one source.
 */
export function projectDetectionFrame(
  frame: DetectionFrame,
  target: DetectionCoordinateSpace,
): DetectionFrame {
  const space = frame.coordinateSpace;

  if (
    !space ||
    !isUsableCoordinateSpace(space) ||
    !isUsableCoordinateSpace(target) ||
    (space.width === target.width && space.height === target.height)
  ) {
    return frame;
  }

  const scaleX = target.width / space.width;
  const scaleY = target.height / space.height;

  return {
    ...frame,
    coordinateSpace: { height: target.height, width: target.width },
    detections: frame.detections.map((detection) =>
      projectDetection(detection, scaleX, scaleY),
    ),
  };
}

/**
 * Projects every frame that declares a source coordinate space into `target`.
 *
 * Frames without coordinate metadata pass through by reference.
 */
export function projectDetectionFrames(
  frames: readonly DetectionFrame[],
  target: DetectionCoordinateSpace,
): readonly DetectionFrame[] {
  let didProject = false;
  const projectedFrames = frames.map((frame) => {
    const projectedFrame = projectDetectionFrame(frame, target);

    didProject ||= projectedFrame !== frame;

    return projectedFrame;
  });

  return didProject ? projectedFrames : frames;
}

function projectDetection(
  detection: Detection,
  scaleX: number,
  scaleY: number,
): Detection {
  return {
    ...detection,
    ...(detection.rect
      ? { rect: scaleRect(detection.rect, scaleX, scaleY) }
      : {}),
    ...(detection.polygon
      ? { polygon: scalePolygon(detection.polygon, scaleX, scaleY) }
      : {}),
    ...(detection.orientedBox
      ? { orientedBox: scaleOrientedBox(detection.orientedBox, scaleX, scaleY) }
      : {}),
    ...(detection.polyline
      ? { polyline: scalePolyline(detection.polyline, scaleX, scaleY) }
      : {}),
    ...(detection.keypoints
      ? { keypoints: scaleKeypoints(detection.keypoints, scaleX, scaleY) }
      : {}),
  };
}

function scaleRect(rect: Rect, scaleX: number, scaleY: number): Rect {
  return {
    height: rect.height * scaleY,
    width: rect.width * scaleX,
    x: rect.x * scaleX,
    y: rect.y * scaleY,
  };
}

function scalePolygon(
  polygon: PolygonGeometry,
  scaleX: number,
  scaleY: number,
): PolygonGeometry {
  return { points: scalePoints(polygon.points, scaleX, scaleY) };
}

/**
 * Scales an explicit oriented-box quadrilateral by independent axis factors.
 *
 * A uniform scale keeps every vertex angle intact, but `scaleX` and `scaleY`
 * can differ when the source and target aspect ratios do not match. That
 * skews the quadrilateral's angles exactly the way it already skews a scaled
 * `Rect` or polygon, so a non-uniform projection stays internally consistent
 * across every detection geometry kind instead of only axis-aligned ones.
 */
function scaleOrientedBox(
  orientedBox: OrientedBoxGeometry,
  scaleX: number,
  scaleY: number,
): OrientedBoxGeometry {
  // `points` is typed as an exact 4-tuple, but a caller that bypasses the
  // type system (e.g. a detection deserialized from untyped data, the same
  // scenario BaseOrientedBoxStyle's own points.length !== 4 guard defends
  // against) can hand this an array of a different length. Scale whatever
  // length was actually given instead of destructuring into a synthetic
  // four-element tuple: destructuring a 3-point array pads a real
  // `undefined` into the fourth slot (which crashes downstream reading
  // `.x`/`.y`), and destructuring a 5+-point array silently truncates it
  // into an apparently-valid box. Preserving the real length lets the
  // style's own guard see and reject the malformed cardinality instead of
  // this function corrupting it into something that looks valid or crashes.
  const scaled = scalePoints(orientedBox.points, scaleX, scaleY);

  return { points: scaled as unknown as readonly [Point, Point, Point, Point] };
}

function scalePolyline(
  polyline: PolylineGeometry,
  scaleX: number,
  scaleY: number,
): PolylineGeometry {
  return { points: scalePoints(polyline.points, scaleX, scaleY) };
}

function scaleKeypoints(
  keypoints: KeypointGeometry,
  scaleX: number,
  scaleY: number,
): KeypointGeometry {
  return {
    ...keypoints,
    points: scalePoints(keypoints.points, scaleX, scaleY),
  };
}

function scalePoints(
  points: readonly Point[],
  scaleX: number,
  scaleY: number,
): readonly Point[] {
  return points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
}

function isUsableCoordinateSpace(space: DetectionCoordinateSpace) {
  return (
    Number.isFinite(space.width) &&
    Number.isFinite(space.height) &&
    space.width > 0 &&
    space.height > 0
  );
}
