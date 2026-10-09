import type { Container, Rectangle } from "pixi.js";

/** The visible canvas in media coordinates, with a top-left origin. */
export interface PixiViewportBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PixiRectangleConstructor = new (
  x?: number,
  y?: number,
  width?: number,
  height?: number,
) => Rectangle;

type BoundedDisplay = { boundsArea?: Rectangle };

export function setPixiViewportBounds(
  display: BoundedDisplay,
  bounds: PixiViewportBounds,
  viewport: PixiViewportBounds | undefined,
  Rectangle: PixiRectangleConstructor,
) {
  if (!viewport) {
    display.boundsArea = undefined;
    return;
  }
  const left = Math.max(bounds.x, viewport.x);
  const top = Math.max(bounds.y, viewport.y);
  const right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width);
  const bottom = Math.min(
    bounds.y + bounds.height,
    viewport.y + viewport.height,
  );
  const clipped = (display.boundsArea ??= new Rectangle());
  clipped.x = left;
  clipped.y = top;
  clipped.width = Math.max(0, right - left);
  clipped.height = Math.max(0, bottom - top);
}

/**
 * AlphaMask allocates from its mask's full bounds, including geometry outside
 * the canvas. A neutral parent clips that allocation without changing a
 * rotated or mirrored child's geometry or texture coordinates.
 */
export function syncPixiMaskViewportBounds(
  container: Pick<Container, "children"> & BoundedDisplay,
  viewport: PixiViewportBounds | undefined,
  Rectangle: PixiRectangleConstructor,
) {
  if (!viewport) {
    container.boundsArea = undefined;
    return;
  }
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const child of container.children) {
    if (!child.visible) continue;
    const bounds = child.getLocalBounds();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    child.updateLocalTransform();
    const { a, b, c, d, tx, ty } = child.localTransform;
    left = Math.min(
      left,
      tx +
        Math.min(a * bounds.minX, a * bounds.maxX) +
        Math.min(c * bounds.minY, c * bounds.maxY),
    );
    top = Math.min(
      top,
      ty +
        Math.min(b * bounds.minX, b * bounds.maxX) +
        Math.min(d * bounds.minY, d * bounds.maxY),
    );
    right = Math.max(
      right,
      tx +
        Math.max(a * bounds.minX, a * bounds.maxX) +
        Math.max(c * bounds.minY, c * bounds.maxY),
    );
    bottom = Math.max(
      bottom,
      ty +
        Math.max(b * bounds.minX, b * bounds.maxX) +
        Math.max(d * bounds.minY, d * bounds.maxY),
    );
  }
  setPixiViewportBounds(
    container,
    left === Infinity
      ? { x: viewport.x, y: viewport.y, width: 0, height: 0 }
      : { x: left, y: top, width: right - left, height: bottom - top },
    viewport,
    Rectangle,
  );
}
