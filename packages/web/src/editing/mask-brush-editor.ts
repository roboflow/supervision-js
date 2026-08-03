import {
  decodeCompressedRleMask,
  encodeBinaryMaskWithBounds,
  type DetectionMask,
  type Point,
  type Rect,
} from "supervision-js-core";

export enum MaskBrushMode {
  Add = "add",
  Erase = "erase",
}

export interface MaskBrushEditor {
  readonly canvas: HTMLCanvasElement;
  beginStroke(
    point: Point,
    options?: { mode?: MaskBrushMode; radius?: number },
  ): void;
  extendStroke(point: Point): void;
  endStroke(): DetectionMask;
  cancelStroke(): void;
  seed(mask: DetectionMask): void;
  clear(): void;
  getMask(): DetectionMask;
  getMaskBounds(): Rect | null;
  getCursor(): { point: Point | null; radius: number; mode: MaskBrushMode };
  setCursor(
    point: Point | null,
    options?: { mode?: MaskBrushMode; radius?: number },
  ): void;
  subscribeTextureUpdates(listener: () => void): () => void;
  subscribeCursorUpdates(listener: () => void): () => void;
}

/** Renderer-neutral connection between a brush editor and its live preview. */
export interface MaskBrushPreviewOptions {
  readonly editor: MaskBrushEditor;
  readonly color?: number;
  readonly alpha?: number;
  readonly cursorColor?: number;
}

/** Mutable live bridge for brush painting. Persistence remains host-owned. */
export function createMaskBrushEditor(options: {
  readonly width: number;
  readonly height: number;
  readonly canvas?: HTMLCanvasElement;
  readonly onCursorUpdate?: () => void;
  readonly onTextureUpdate?: () => void;
  readonly onCommit?: (mask: DetectionMask) => void;
}): MaskBrushEditor {
  const canvas = options.canvas ?? document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!context) throw new Error("Unable to create mask brush canvas context.");
  const brushContext = context;

  let lastPoint: Point | null = null;
  let binary = new Uint8Array(canvas.width * canvas.height);
  let cachedOutput: ReturnType<typeof encodeBinaryMaskWithBounds> | null = null;
  let strokeDirtyRect: RasterRect | null = null;
  let strokePatches: BinaryPatch[] = [];
  let stroking = false;
  let radius = 12;
  let mode = MaskBrushMode.Add;
  let cursor: Point | null = null;
  const cursorListeners = new Set<() => void>();
  const textureListeners = new Set<() => void>();

  return {
    canvas,
    beginStroke(point, strokeOptions = {}) {
      if (stroking) return;
      stroking = true;
      strokeDirtyRect = null;
      strokePatches = [];
      radius = Math.max(0.5, strokeOptions.radius ?? radius);
      mode = strokeOptions.mode ?? mode;
      lastPoint = point;
      cursor = point;
      if (paintPoints([point])) updateTexture();
      updateCursor();
    },
    extendStroke(point) {
      cursor = point;
      if (!lastPoint || !stroking) {
        updateCursor();
        return;
      }
      if (paintPoints(bresenham(lastPoint, point))) updateTexture();
      lastPoint = point;
      updateCursor();
    },
    endStroke() {
      if (!stroking) return getMask();
      stroking = false;
      strokeDirtyRect = null;
      strokePatches = [];
      lastPoint = null;
      const mask = getMask();
      options.onCommit?.(mask);
      return mask;
    },
    cancelStroke() {
      if (!stroking) return;
      for (let index = strokePatches.length - 1; index >= 0; index -= 1) {
        restoreBinaryPatch(binary, canvas.width, strokePatches[index]!);
      }
      if (strokeDirtyRect) writeBinaryRect(strokeDirtyRect);
      stroking = false;
      strokeDirtyRect = null;
      strokePatches = [];
      lastPoint = null;
      cachedOutput = null;
      updateTexture();
      updateCursor();
    },
    seed(mask) {
      const decoded = decodeCompressedRleMask(mask);
      if (decoded.width !== canvas.width || decoded.height !== canvas.height) {
        throw new Error("Seed mask dimensions must match the brush canvas.");
      }
      binary = decoded.data.slice();
      const image = brushContext.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < binary.length; index += 1) {
        if (!binary[index]) continue;
        const offset = index * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = 255;
      }
      brushContext.putImageData(image, 0, 0);
      cachedOutput = null;
      updateTexture();
    },
    clear() {
      brushContext.clearRect(0, 0, canvas.width, canvas.height);
      binary.fill(0);
      cachedOutput = null;
      updateTexture();
    },
    getMask,
    getMaskBounds: () => getOutput().bounds,
    getCursor: () => ({ mode, point: cursor, radius }),
    setCursor(point, cursorOptions = {}) {
      cursor = point;
      radius = Math.max(0.5, cursorOptions.radius ?? radius);
      mode = cursorOptions.mode ?? mode;
      updateCursor();
    },
    subscribeTextureUpdates(listener) {
      textureListeners.add(listener);
      return () => textureListeners.delete(listener);
    },
    subscribeCursorUpdates(listener) {
      cursorListeners.add(listener);
      return () => cursorListeners.delete(listener);
    },
  };

  function paintPoints(points: readonly Point[]) {
    const dirtyRect = getPaintRect(points, radius, canvas.width, canvas.height);
    if (!dirtyRect) return false;
    strokePatches.push(copyBinaryPatch(binary, canvas.width, dirtyRect));
    strokeDirtyRect = unionRasterRects(strokeDirtyRect, dirtyRect);

    brushContext.save();
    brushContext.globalCompositeOperation =
      mode === MaskBrushMode.Erase ? "destination-out" : "source-over";
    brushContext.fillStyle = "white";
    for (const point of points) {
      brushContext.beginPath();
      brushContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
      brushContext.fill();
    }
    brushContext.restore();
    syncBinaryRect(dirtyRect);
    cachedOutput = null;
    return true;
  }

  function getMask() {
    return getOutput().mask;
  }

  function getOutput() {
    cachedOutput ??= encodeBinaryMaskWithBounds(
      binary,
      canvas.width,
      canvas.height,
    );
    return cachedOutput;
  }

  function syncBinaryRect(rect: RasterRect) {
    const rgba = brushContext.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    ).data;
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const target = (rect.y + y) * canvas.width + rect.x + x;
        const source = (y * rect.width + x) * 4 + 3;
        binary[target] = rgba[source]! > 0 ? 1 : 0;
      }
    }
  }

  function writeBinaryRect(rect: RasterRect) {
    const image = brushContext.createImageData(rect.width, rect.height);
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        if (!binary[(rect.y + y) * canvas.width + rect.x + x]) continue;
        const offset = (y * rect.width + x) * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = 255;
      }
    }
    brushContext.putImageData(image, rect.x, rect.y);
  }

  function updateTexture() {
    options.onTextureUpdate?.();
    for (const listener of textureListeners) listener();
  }

  function updateCursor() {
    options.onCursorUpdate?.();
    for (const listener of cursorListeners) listener();
  }
}

interface RasterRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface BinaryPatch {
  readonly data: Uint8Array;
  readonly rect: RasterRect;
}

function getPaintRect(
  points: readonly Point[],
  radius: number,
  width: number,
  height: number,
): RasterRect | null {
  if (points.length === 0) return null;
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const padding = radius + 1;
  const left = Math.max(0, Math.floor(minX - padding));
  const top = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(width, Math.ceil(maxX + padding));
  const bottom = Math.min(height, Math.ceil(maxY + padding));
  return right <= left || bottom <= top
    ? null
    : { height: bottom - top, width: right - left, x: left, y: top };
}

function copyBinaryPatch(
  binary: Uint8Array,
  stride: number,
  rect: RasterRect,
): BinaryPatch {
  const data = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    data.set(
      binary.subarray(
        (rect.y + y) * stride + rect.x,
        (rect.y + y) * stride + rect.x + rect.width,
      ),
      y * rect.width,
    );
  }
  return { data, rect };
}

function restoreBinaryPatch(
  binary: Uint8Array,
  stride: number,
  patch: BinaryPatch,
) {
  for (let y = 0; y < patch.rect.height; y += 1) {
    binary.set(
      patch.data.subarray(y * patch.rect.width, (y + 1) * patch.rect.width),
      (patch.rect.y + y) * stride + patch.rect.x,
    );
  }
}

function unionRasterRects(
  current: RasterRect | null,
  next: RasterRect,
): RasterRect {
  if (!current) return next;
  const x = Math.min(current.x, next.x);
  const y = Math.min(current.y, next.y);
  const right = Math.max(current.x + current.width, next.x + next.width);
  const bottom = Math.max(current.y + current.height, next.y + next.height);
  return { height: bottom - y, width: right - x, x, y };
}

function bresenham(from: Point, to: Point) {
  const points: Point[] = [];
  let x = Math.round(from.x);
  let y = Math.round(from.y);
  const targetX = Math.round(to.x);
  const targetY = Math.round(to.y);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    points.push({ x, y });
    if (x === targetX && y === targetY) break;
    const twice = error * 2;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}
