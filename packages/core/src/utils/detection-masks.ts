import {
  DetectionMaskEncoding,
  type CompressedRleDetectionMask,
  type DetectionMask,
  type Point,
  type Rect,
  type TopLeftRect,
} from "#types/detections";
import {
  decodeDetectionMask,
  encodeCompressedRleCounts,
} from "#utils/detection-frames";

export enum DetectionMaskPayloadFormat {
  RawCocoRle = "rawCocoRle",
  DeflatedBase64 = "deflatedBase64",
}

/** Host adapter for the editor's optional pako + base64 transport format. */
export interface DetectionMaskCompressionCodec {
  deflate(value: string): string;
  inflate(value: string): string;
}

export type MaskRectRun = TopLeftRect;

export interface EncodedBinaryMask {
  readonly bounds: Rect | null;
  readonly mask: CompressedRleDetectionMask;
}

export function encodeBinaryMask(
  data: Uint8Array,
  width: number,
  height: number,
): CompressedRleDetectionMask {
  assertMaskDimensions(data, width, height);

  const runs: number[] = [];
  let currentValue = 0;
  let runLength = 0;

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const value = data[y * width + x] ? 1 : 0;

      if (value === currentValue) {
        runLength += 1;
      } else {
        runs.push(runLength);
        currentValue = value;
        runLength = 1;
      }
    }
  }

  runs.push(runLength);

  return {
    counts: encodeCompressedRleCounts(runs),
    encoding: DetectionMaskEncoding.CompressedRle,
    height,
    width,
  };
}

/** Encodes a binary mask and derives its bounds in the same raster traversal. */
export function encodeBinaryMaskWithBounds(
  data: Uint8Array,
  width: number,
  height: number,
): EncodedBinaryMask {
  assertMaskDimensions(data, width, height);

  const runs: number[] = [];
  let currentValue = 0;
  let runLength = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const value = data[y * width + x] ? 1 : 0;

      if (value) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }

      if (value === currentValue) {
        runLength += 1;
      } else {
        runs.push(runLength);
        currentValue = value;
        runLength = 1;
      }
    }
  }

  runs.push(runLength);

  return {
    bounds:
      maxX < 0
        ? null
        : {
            height: maxY - minY + 1,
            width: maxX - minX + 1,
            x: minX + (maxX - minX + 1) / 2,
            y: minY + (maxY - minY + 1) / 2,
          },
    mask: {
      counts: encodeCompressedRleCounts(runs),
      encoding: DetectionMaskEncoding.CompressedRle,
      height,
      width,
    },
  };
}

/**
 * The payload format is the RLE counts string, so this accepts only the
 * cold-storage encoding. Convert a dense mask with `encodeDenseBitmapMask()`
 * before storing it.
 */
export function encodeDetectionMaskPayload(
  mask: CompressedRleDetectionMask,
  codec?: DetectionMaskCompressionCodec,
): string {
  return codec ? codec.deflate(mask.counts) : mask.counts;
}

export function decodeDetectionMaskPayload(
  payload: string,
  width: number,
  height: number,
  options: {
    readonly codec?: DetectionMaskCompressionCodec;
    readonly format?: DetectionMaskPayloadFormat;
  } = {},
): CompressedRleDetectionMask {
  const format =
    options.format ??
    (isDeflatedBase64DetectionMaskPayload(payload)
      ? DetectionMaskPayloadFormat.DeflatedBase64
      : DetectionMaskPayloadFormat.RawCocoRle);

  if (format === DetectionMaskPayloadFormat.DeflatedBase64 && !options.codec) {
    throw new Error(
      "A detection mask compression codec is required for deflated payloads.",
    );
  }

  return {
    counts:
      format === DetectionMaskPayloadFormat.DeflatedBase64
        ? options.codec!.inflate(payload)
        : payload,
    encoding: DetectionMaskEncoding.CompressedRle,
    height,
    width,
  };
}

/** Matches the annotation editor's legacy transport-format heuristic. */
export function isDeflatedBase64DetectionMaskPayload(value: string): boolean {
  return value.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function computeMaskBounds(
  data: Uint8Array,
  width: number,
  height: number,
): Rect | null {
  assertMaskDimensions(data, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!data[y * width + x]) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < 0) {
    return null;
  }

  const boundsWidth = maxX - minX + 1;
  const boundsHeight = maxY - minY + 1;

  return {
    height: boundsHeight,
    width: boundsWidth,
    x: minX + boundsWidth / 2,
    y: minY + boundsHeight / 2,
  };
}

export function computeDetectionMaskRect(
  mask: DetectionMask,
): Rect | undefined {
  const decoded = decodeDetectionMask(mask);
  const bounds = computeMaskBounds(decoded.data, decoded.width, decoded.height);
  return bounds ?? undefined;
}

export function detectMaskBorders(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  assertMaskDimensions(data, width, height);
  const borders = new Uint8Array(data.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;

      if (!data[offset]) {
        continue;
      }

      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !data[offset - 1] ||
        !data[offset + 1] ||
        !data[offset - width] ||
        !data[offset + width]
      ) {
        borders[offset] = 1;
      }
    }
  }

  return borders;
}

export function extractMaskContour(
  data: Uint8Array,
  width: number,
  height: number,
): readonly Point[] | undefined {
  assertMaskDimensions(data, width, height);
  const stride = Math.max(1, Math.floor(height / 100));
  const leftEdge: Point[] = [];
  const rightEdge: Point[] = [];

  for (let y = 0; y < height; y += stride) {
    let left = -1;
    let right = -1;

    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]) {
        left = left === -1 ? x : left;
        right = x;
      }
    }

    if (left !== -1) {
      leftEdge.push({ x: left, y });
      rightEdge.push({ x: right, y });
    }
  }

  return leftEdge.length < 2
    ? undefined
    : [...leftEdge, ...rightEdge.reverse()];
}

export function extractMaskRectRuns(
  data: Uint8Array,
  width: number,
  height: number,
): readonly MaskRectRun[] | undefined {
  assertMaskDimensions(data, width, height);
  const rects: MaskRectRun[] = [];
  const openRects = new Map<string, TopLeftRect>();

  for (let y = 0; y < height; y += 1) {
    const activeSpans = new Set<string>();
    let x = 0;

    while (x < width) {
      while (x < width && !data[y * width + x]) {
        x += 1;
      }

      if (x >= width) {
        break;
      }

      const startX = x;

      while (x < width && data[y * width + x]) {
        x += 1;
      }

      const runWidth = x - startX;
      const key = `${startX}:${runWidth}`;
      const openRect = openRects.get(key);
      activeSpans.add(key);

      if (openRect && openRect.y + openRect.height === y) {
        openRects.set(key, { ...openRect, height: openRect.height + 1 });
      } else {
        if (openRect) {
          rects.push(openRect);
        }

        openRects.set(key, { height: 1, width: runWidth, x: startX, y });
      }
    }

    for (const [key, openRect] of openRects) {
      if (!activeSpans.has(key)) {
        rects.push(openRect);
        openRects.delete(key);
      }
    }
  }

  rects.push(...openRects.values());
  return rects.length > 0 ? rects : undefined;
}

function assertMaskDimensions(data: Uint8Array, width: number, height: number) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error("Mask width must be a positive integer.");
  }

  if (!Number.isInteger(height) || height <= 0) {
    throw new Error("Mask height must be a positive integer.");
  }

  if (data.length !== width * height) {
    throw new Error("Mask data length must equal width * height.");
  }
}
