import {
  DetectionMaskEncoding,
  type DetectionMask,
  type Point,
  type Rect,
  type TopLeftRect,
} from "#types/detections";
import {
  decodeCompressedRleCounts,
  decodeCompressedRleMask,
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
  readonly mask: DetectionMask;
}

export function encodeBinaryMask(
  data: Uint8Array,
  width: number,
  height: number,
): DetectionMask {
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

export function encodeDetectionMaskPayload(
  mask: DetectionMask,
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
): DetectionMask {
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
  const decoded = decodeCompressedRleMask(mask);
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
  const rects = mergeRowSpansIntoRects(data, width, height, 0, 0);
  return rects.length > 0 ? rects : undefined;
}

/**
 * The rect runs of a compressed-RLE mask, without holding the mask's raster.
 *
 * A mask is the size of the whole frame, so reading a silhouette that covers a
 * fraction of one percent of it otherwise costs a megabytes-wide allocation and
 * a pass over every pixel. The counts carry the occupied box, so the raster and
 * the pass are that box.
 */
export function extractDetectionMaskRectRuns(
  mask: DetectionMask,
): readonly MaskRectRun[] | undefined {
  if (mask.encoding !== DetectionMaskEncoding.CompressedRle) {
    throw new Error(`Unsupported detection mask encoding: ${mask.encoding}`);
  }

  const { height, width } = mask;
  assertMaskSize(width, height);

  const counts = decodeCompressedRleCounts(mask.counts);
  const bounds = computeCompressedRleBounds(counts, width, height);

  if (!bounds) {
    return undefined;
  }

  const { left, top } = bounds;
  const boundsWidth = bounds.width;
  const boundsHeight = bounds.height;
  const boundsBuffer = new Uint8Array(boundsWidth * boundsHeight);
  const pixels = width * height;
  let offset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const start = offset;
    offset += counts[index] ?? 0;

    if (!isForegroundRun(index) || start >= pixels) {
      continue;
    }

    const end = Math.min(offset, pixels);
    let cursor = start;

    while (cursor < end) {
      const column = Math.floor(cursor / height);
      const columnEnd = Math.min(end, (column + 1) * height);
      let target =
        (cursor - column * height - top) * boundsWidth + (column - left);

      for (let step = columnEnd - cursor; step > 0; step -= 1) {
        boundsBuffer[target] = 1;
        target += boundsWidth;
      }

      cursor = columnEnd;
    }
  }

  const rects = mergeRowSpansIntoRects(
    boundsBuffer,
    boundsWidth,
    boundsHeight,
    left,
    top,
  );
  return rects.length > 0 ? rects : undefined;
}

/** Counts alternate background, foreground, starting on background. */
function isForegroundRun(index: number) {
  return index % 2 === 1;
}

/**
 * The occupied box of a compressed-RLE mask, read from the counts alone.
 *
 * COCO runs are column-major, so a run confined to one column bounds its own
 * rows, and a run that reaches the next column has already spanned a full
 * column top to bottom.
 */
function computeCompressedRleBounds(
  counts: readonly number[],
  width: number,
  height: number,
) {
  const pixels = width * height;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let offset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const start = offset;
    offset += counts[index] ?? 0;

    if (!isForegroundRun(index) || start >= pixels) {
      continue;
    }

    const end = Math.min(offset, pixels) - 1;
    const startColumn = Math.floor(start / height);
    const endColumn = Math.floor(end / height);

    if (startColumn < left) {
      left = startColumn;
    }

    if (endColumn > right) {
      right = endColumn;
    }

    if (startColumn !== endColumn) {
      top = 0;
      bottom = height - 1;
      continue;
    }

    const startRow = start - startColumn * height;
    const endRow = end - endColumn * height;

    if (startRow < top) {
      top = startRow;
    }

    if (endRow > bottom) {
      bottom = endRow;
    }
  }

  return right < 0
    ? null
    : {
        height: bottom - top + 1,
        left,
        top,
        width: right - left + 1,
      };
}

/** Open rects, one per span of the row above, in the order they opened. */
interface OpenMaskSpans {
  readonly openedAt: Int32Array;
  readonly runWidth: Int32Array;
  readonly startX: Int32Array;
  readonly topY: Int32Array;
}

function createOpenMaskSpans(capacity: number): OpenMaskSpans {
  return {
    openedAt: new Int32Array(capacity),
    runWidth: new Int32Array(capacity),
    startX: new Int32Array(capacity),
    topY: new Int32Array(capacity),
  };
}

/**
 * Emits rects in the coordinates of the raster the given window was cut from,
 * not the window's own.
 *
 * A span continues the rect above it when its start and width both match, and
 * the row above holds exactly one open rect per span, so walking both in
 * ascending x pairs them without a lookup.
 */
function mergeRowSpansIntoRects(
  data: Uint8Array,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): MaskRectRun[] {
  const rects: MaskRectRun[] = [];
  // Spans need a gap between them, so a row holds at most half its width.
  const capacity = (width >> 1) + 2;
  const closed = new Int32Array(capacity);
  let open = createOpenMaskSpans(capacity);
  let next = createOpenMaskSpans(capacity);
  let openCount = 0;
  let opened = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let nextCount = 0;
    let closedCount = 0;
    let cursor = 0;
    let x = 0;

    while (x < width) {
      while (x < width && data[row + x] === 0) {
        x += 1;
      }

      if (x >= width) {
        break;
      }

      const startX = x;

      while (x < width && data[row + x] !== 0) {
        x += 1;
      }

      const runWidth = x - startX;

      while (cursor < openCount && open.startX[cursor] < startX) {
        closed[closedCount] = cursor;
        closedCount += 1;
        cursor += 1;
      }

      if (
        cursor < openCount &&
        open.startX[cursor] === startX &&
        open.runWidth[cursor] === runWidth
      ) {
        next.openedAt[nextCount] = open.openedAt[cursor];
        next.topY[nextCount] = open.topY[cursor];
        cursor += 1;
      } else {
        if (cursor < openCount && open.startX[cursor] === startX) {
          closed[closedCount] = cursor;
          closedCount += 1;
          cursor += 1;
        }

        next.openedAt[nextCount] = opened;
        next.topY[nextCount] = y;
        opened += 1;
      }

      next.runWidth[nextCount] = runWidth;
      next.startX[nextCount] = startX;
      nextCount += 1;
    }

    while (cursor < openCount) {
      closed[closedCount] = cursor;
      closedCount += 1;
      cursor += 1;
    }

    pushClosedRects(rects, open, closed, closedCount, y, offsetX, offsetY);

    const carried = open;
    open = next;
    next = carried;
    openCount = nextCount;
  }

  for (let index = 0; index < openCount; index += 1) {
    closed[index] = index;
  }

  pushClosedRects(rects, open, closed, openCount, height, offsetX, offsetY);
  return rects;
}

/** Rects leave in the order they opened, which is not their order across a row. */
function pushClosedRects(
  rects: MaskRectRun[],
  open: OpenMaskSpans,
  closed: Int32Array,
  closedCount: number,
  bottomY: number,
  offsetX: number,
  offsetY: number,
) {
  for (let index = 1; index < closedCount; index += 1) {
    const span = closed[index];
    const openedAt = open.openedAt[span];
    let sorted = index - 1;

    while (sorted >= 0 && open.openedAt[closed[sorted]] > openedAt) {
      closed[sorted + 1] = closed[sorted];
      sorted -= 1;
    }

    closed[sorted + 1] = span;
  }

  for (let index = 0; index < closedCount; index += 1) {
    const span = closed[index];
    rects.push({
      height: bottomY - open.topY[span],
      width: open.runWidth[span],
      x: open.startX[span] + offsetX,
      y: open.topY[span] + offsetY,
    });
  }
}

function assertMaskSize(width: number, height: number) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error("Mask width must be a positive integer.");
  }

  if (!Number.isInteger(height) || height <= 0) {
    throw new Error("Mask height must be a positive integer.");
  }
}

function assertMaskDimensions(data: Uint8Array, width: number, height: number) {
  assertMaskSize(width, height);

  if (data.length !== width * height) {
    throw new Error("Mask data length must equal width * height.");
  }
}
