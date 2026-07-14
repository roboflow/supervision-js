import {
  decodeCompressedRleMask,
  encodeBinaryMask,
  type DetectionMask,
  type Point,
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
  getCursor(): { point: Point | null; radius: number; mode: MaskBrushMode };
  setCursor(
    point: Point | null,
    options?: { mode?: MaskBrushMode; radius?: number },
  ): void;
  subscribeTextureUpdates(listener: () => void): () => void;
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
  let snapshot: ImageData | null = null;
  let radius = 12;
  let mode = MaskBrushMode.Add;
  let cursor: Point | null = null;
  const textureListeners = new Set<() => void>();

  return {
    canvas,
    beginStroke(point, strokeOptions = {}) {
      if (snapshot) return;
      snapshot = brushContext.getImageData(0, 0, canvas.width, canvas.height);
      radius = Math.max(0.5, strokeOptions.radius ?? radius);
      mode = strokeOptions.mode ?? mode;
      lastPoint = point;
      cursor = point;
      paintPoint(point);
      update();
    },
    extendStroke(point) {
      cursor = point;
      if (!lastPoint || !snapshot) return;
      for (const interpolated of bresenham(lastPoint, point))
        paintPoint(interpolated);
      lastPoint = point;
      update();
    },
    endStroke() {
      if (!snapshot) return getMask();
      snapshot = null;
      lastPoint = null;
      const mask = getMask();
      options.onCommit?.(mask);
      return mask;
    },
    cancelStroke() {
      if (snapshot) brushContext.putImageData(snapshot, 0, 0);
      snapshot = null;
      lastPoint = null;
      update();
    },
    seed(mask) {
      const decoded = decodeCompressedRleMask(mask);
      if (decoded.width !== canvas.width || decoded.height !== canvas.height) {
        throw new Error("Seed mask dimensions must match the brush canvas.");
      }
      const image = brushContext.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < decoded.data.length; index += 1) {
        if (!decoded.data[index]) continue;
        const offset = index * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = 255;
      }
      brushContext.putImageData(image, 0, 0);
      update();
    },
    clear() {
      brushContext.clearRect(0, 0, canvas.width, canvas.height);
      update();
    },
    getMask,
    getCursor: () => ({ mode, point: cursor, radius }),
    setCursor(point, cursorOptions = {}) {
      cursor = point;
      radius = Math.max(0.5, cursorOptions.radius ?? radius);
      mode = cursorOptions.mode ?? mode;
      update();
    },
    subscribeTextureUpdates(listener) {
      textureListeners.add(listener);
      return () => textureListeners.delete(listener);
    },
  };

  function paintPoint(point: Point) {
    brushContext.save();
    brushContext.globalCompositeOperation =
      mode === MaskBrushMode.Erase ? "destination-out" : "source-over";
    brushContext.fillStyle = "white";
    brushContext.beginPath();
    brushContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
    brushContext.fill();
    brushContext.restore();
  }

  function getMask() {
    const rgba = brushContext.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    const binary = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < binary.length; index += 1) {
      binary[index] = rgba[index * 4 + 3]! > 0 ? 1 : 0;
    }
    return encodeBinaryMask(binary, canvas.width, canvas.height);
  }

  function update() {
    options.onTextureUpdate?.();
    for (const listener of textureListeners) listener();
  }
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
