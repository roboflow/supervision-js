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

/** Recovers ordered rectangle axes, allowing corner coordinates rounded to 0.1 media pixels.
 * The least-squares rectangle preserves the supplied local axes; vertices are never reordered.
 * Returns null for non-clockwise, degenerate, or more substantially distorted quadrilaterals. */
export function getOrientedRectangleGeometry(
  box: OrientedBoxGeometry,
): OrientedRectangleGeometry | null {
  if (
    box.points.length !== 4 ||
    !box.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
  )
    return null;
  const [a, b, c, d] = box.points;
  const edges = box.points.map((point, index) => {
    const next = box.points[(index + 1) % 4]!;
    return { x: next.x - point.x, y: next.y - point.y };
  });
  const lengths = edges.map(({ x, y }) => Math.hypot(x, y));
  for (let index = 0; index < 4; index++) {
    const edge = edges[index]!;
    const next = edges[(index + 1) % 4]!;
    const length = lengths[index]!;
    const nextLength = lengths[(index + 1) % 4]!;
    if (
      !Number.isFinite(length) ||
      length === 0 ||
      !Number.isFinite(nextLength) ||
      nextLength === 0 ||
      (edge.x / length) * (next.y / nextLength) -
        (edge.y / length) * (next.x / nextLength) <=
        0
    )
      return null;
  }

  // Opposite-edge means retain local +x/+y even for squares or width < height.
  const ex = (b.x - a.x) / 2 + (c.x - d.x) / 2;
  const ey = (b.y - a.y) / 2 + (c.y - d.y) / 2;
  const fx = (d.x - a.x) / 2 + (c.x - b.x) / 2;
  const fy = (d.y - a.y) / 2 + (c.y - b.y) / 2;
  const size = Math.max(Math.abs(ex), Math.abs(ey), Math.abs(fx), Math.abs(fy));
  if (!Number.isFinite(size) || size === 0) return null;
  const scaledEx = ex / size;
  const scaledEy = ey / size;
  const scaledFx = fx / size;
  const scaledFy = fy / size;
  const angle =
    Math.atan2(
      2 * (scaledEx * scaledEy - scaledFx * scaledFy),
      scaledEx ** 2 - scaledEy ** 2 + scaledFy ** 2 - scaledFx ** 2,
    ) / 2;
  let cos = Math.cos(angle);
  let sin = Math.sin(angle);
  let width = ex * cos + ey * sin;
  let height = -fx * sin + fy * cos;
  if (width < 0) {
    cos = -cos;
    sin = -sin;
    width = -width;
    height = -height;
  }

  // Work relative to a, avoiding cancellation from large translated coordinates.
  const local = box.points.map((point) => ({
    x: point.x - a.x,
    y: point.y - a.y,
  }));
  const centerX = local.reduce((sum, point) => sum + point.x / 4, 0);
  const centerY = local.reduce((sum, point) => sum + point.y / 4, 0);
  const x = a.x / 4 + c.x / 4 + (b.x / 4 + d.x / 4);
  const y = a.y / 4 + c.y / 4 + (b.y / 4 + d.y / 4);
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const residuals = local.flatMap((point, index) => {
    const halfWidth = (index === 0 || index === 3 ? -width : width) / 2;
    const halfHeight = (index < 2 ? -height : height) / 2;
    return [
      point.x - centerX - halfWidth * cos + halfHeight * sin,
      point.y - centerY - halfWidth * sin - halfHeight * cos,
    ];
  });
  // Rounding eight coordinates to q = 0.1 contributes at most 8(q/2)^2 = 0.02
  // squared pixels. The optimal ordered rectangle cannot have a larger error.
  const tolerance = Math.SQRT2 * 0.1 + 16 * Number.EPSILON * size;
  const error = Math.hypot(...residuals);
  if (!Number.isFinite(error) || error > tolerance) return null;
  return {
    x,
    y,
    width,
    height,
    rotation: Math.atan2(sin, cos),
  };
}
