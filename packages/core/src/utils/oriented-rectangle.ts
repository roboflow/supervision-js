import type { OrientedBoxGeometry, Point, Rect } from "#types/detections";

/** Center x/y, positive local width/height, and clockwise radians in media coordinates. */
export type OrientedRectangleGeometry = Rect & { readonly rotation: number };

/** Creates clockwise local top-left, top-right, bottom-right, bottom-left corners
 * from a center-based rectangle and clockwise radians, without sorting axes. */
export function createOrientedBoxGeometry(
  rect: Rect,
  rotation = 0,
): OrientedBoxGeometry {
  if (
    ![rect.x, rect.y, rect.width, rect.height, rotation].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new RangeError(
      "An oriented rectangle requires finite coordinates and positive dimensions",
    );
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const point = (x: number, y: number): Point => ({
    x: rect.x + x * cos - y * sin,
    y: rect.y + x * sin + y * cos,
  });
  return {
    points: [
      point(-rect.width / 2, -rect.height / 2),
      point(rect.width / 2, -rect.height / 2),
      point(rect.width / 2, rect.height / 2),
      point(-rect.width / 2, rect.height / 2),
    ],
  };
}

/** Returns ordered axes only for a nondegenerate clockwise rectangle; never fits or reorders a quad. */
export function getOrientedRectangleGeometry(
  box: OrientedBoxGeometry,
): OrientedRectangleGeometry | null {
  const [a, b, c, d] = box.points;
  if (!box.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)))
    return null;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - a.x;
  const vy = d.y - a.y;
  const width = Math.hypot(ux, uy);
  const height = Math.hypot(vx, vy);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 1e-9 ||
    height <= 1e-9 ||
    ux * vy - uy * vx <= 0
  )
    return null;
  const tolerance = 1e-6 * Math.max(width, height);
  if (
    Math.abs((ux * vx + uy * vy) / (width * height)) > 1e-6 ||
    Math.hypot(c.x - b.x - d.x + a.x, c.y - b.y - d.y + a.y) > tolerance
  )
    return null;
  return {
    x: (a.x + c.x) / 2,
    y: (a.y + c.y) / 2,
    width,
    height,
    rotation: Math.atan2(uy, ux),
  };
}
