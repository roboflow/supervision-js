import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import type {
  PreparedIdMaskPlane,
  PreparedRegionMaskCoverageEntry,
  PreparedRegionMaskCoverageFrame,
} from "#render-preparation/mask-frame-artifact";
import type { MaskStrokeStyle } from "supervision-js-core";
import {
  createIdMaskFrame,
  decodeCompressedRleMask,
  encodeBinaryMask,
  rasterizePolygonToMask,
  type IdMaskInstruction,
  type IdMaskFrame,
} from "supervision-js-core";
export {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  createIdMaskFrame,
  type IdMaskFrame,
} from "supervision-js-core";

interface DecodedMaskPixels {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface RgbaColor {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

export interface CompositedMaskFrame {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly height: number;
  readonly width: number;
}

/** Builds compact, independent alpha crops so overlapping masks stay exact. */
export function createRegionMaskCoverageFrame(
  instructions: readonly SerializableMaskInstruction[],
): PreparedRegionMaskCoverageFrame | undefined {
  const entries: PreparedRegionMaskCoverageEntry[] = [];

  for (const instruction of instructions) {
    if (!instruction.regionCoverageMask) {
      continue;
    }

    const entry = cropCoverageMask(
      instruction.detectionIndex,
      decodeCompressedRleMask(instruction.regionCoverageMask),
    );

    if (entry) {
      entries.push(entry);
    }
  }

  return entries.length > 0 ? { entries } : undefined;
}

function cropCoverageMask(
  detectionIndex: number,
  decodedMask: DecodedMaskPixels,
): PreparedRegionMaskCoverageEntry | undefined {
  let minX = decodedMask.width;
  let minY = decodedMask.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      if (!decodedMask.data[y * decodedMask.width + x]) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return undefined;
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const data = new Uint8Array(new ArrayBuffer(width * height));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!decodedMask.data[y * decodedMask.width + x]) {
        continue;
      }

      data[(y - minY) * width + (x - minX)] = 255;
    }
  }

  return { data, detectionIndex, height, width, x: minX, y: minY };
}

export function compositeMaskFrame(
  instructions: readonly SerializableMaskInstruction[],
): CompositedMaskFrame | undefined {
  const maskInstructions = materializeMaskInstructions(instructions);

  if (maskInstructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...maskInstructions.map(({ mask }) => mask.width));
  const height = Math.max(...maskInstructions.map(({ mask }) => mask.height));
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (const instruction of maskInstructions) {
    compositeInstruction(data, width, instruction);
  }

  return { data, height, width };
}

export function createIdMaskRasterFrame(
  instructions: readonly SerializableMaskInstruction[],
  maxRasterWidth?: number,
): IdMaskFrame | undefined {
  try {
    return createIdMaskFrame(materializeMaskInstructions(instructions), {
      maxWidth: maxRasterWidth,
    });
  } catch {
    // The id raster is the fast path, not the only one: answering with nothing
    // puts the caller on the RGBA composite, which draws the same picture.
    return undefined;
  }
}

export function createIdMaskPlane(
  instructions: readonly SerializableMaskInstruction[],
  maxRasterWidth?: number,
): PreparedIdMaskPlane | undefined {
  const frame = createIdMaskRasterFrame(instructions, maxRasterWidth);

  return frame
    ? { data: frame.data, height: frame.height, width: frame.width }
    : undefined;
}

function compositeInstruction(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  instruction: IdMaskInstruction,
) {
  const decodedMask = decodeCompressedRleMask(instruction.mask);
  const fill = resolveRgbaColor(instruction.color, instruction.alpha);

  compositeMaskFill(rgba, canvasWidth, decodedMask, fill);

  if (instruction.stroke) {
    compositeMaskStroke(rgba, canvasWidth, decodedMask, instruction.stroke);
  }
}

function materializeMaskInstructions(
  instructions: readonly SerializableMaskInstruction[],
): IdMaskInstruction[] {
  return instructions
    .filter((instruction) => instruction.visible !== false)
    .map((instruction) => {
      if (instruction.mask) {
        return instruction;
      }

      const { height, points, width } = instruction.polygon;

      return {
        alpha: instruction.alpha,
        color: instruction.color,
        detectionIndex: instruction.detectionIndex,
        mask: encodeBinaryMask(
          rasterizePolygonToMask(points, { height, width }),
          width,
          height,
        ),
        stroke: instruction.stroke,
      };
    });
}

function compositeMaskFill(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  fill: RgbaColor,
) {
  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const maskOffset = y * decodedMask.width + x;

      if (!decodedMask.data[maskOffset]) {
        continue;
      }

      writePixel(rgba, canvasWidth, x, y, fill);
    }
  }
}

function compositeMaskStroke(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  stroke: MaskStrokeStyle,
) {
  const width = Math.round(stroke.width);

  if (width <= 0) {
    return;
  }

  const strokeColor = resolveRgbaColor(stroke.color, stroke.alpha);

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      if (
        !isMaskPixel(decodedMask, x, y) ||
        !isBoundaryPixel(decodedMask, x, y)
      ) {
        continue;
      }

      for (let offsetY = -width; offsetY <= width; offsetY += 1) {
        for (let offsetX = -width; offsetX <= width; offsetX += 1) {
          const strokeX = x + offsetX;
          const strokeY = y + offsetY;

          if (
            isOutsideMaskBounds(decodedMask, strokeX, strokeY) ||
            isMaskPixel(decodedMask, strokeX, strokeY)
          ) {
            continue;
          }

          writePixel(rgba, canvasWidth, strokeX, strokeY, strokeColor);
        }
      }
    }
  }
}

function isBoundaryPixel(mask: DecodedMaskPixels, x: number, y: number) {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) {
        continue;
      }

      const neighborX = x + offsetX;
      const neighborY = y + offsetY;

      if (
        isOutsideMaskBounds(mask, neighborX, neighborY) ||
        !isMaskPixel(mask, neighborX, neighborY)
      ) {
        return true;
      }
    }
  }

  return false;
}

function isMaskPixel(mask: DecodedMaskPixels, x: number, y: number) {
  return mask.data[y * mask.width + x] === 1;
}

function isOutsideMaskBounds(mask: DecodedMaskPixels, x: number, y: number) {
  return x < 0 || y < 0 || x >= mask.width || y >= mask.height;
}

function resolveRgbaColor(color: number, alpha: number): RgbaColor {
  return {
    alpha: Math.round(Math.max(0, Math.min(alpha, 1)) * 255),
    blue: color & 0xff,
    green: (color >> 8) & 0xff,
    red: (color >> 16) & 0xff,
  };
}

function writePixel(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  x: number,
  y: number,
  color: RgbaColor,
) {
  const rgbaOffset = (y * canvasWidth + x) * 4;

  rgba[rgbaOffset] = color.red;
  rgba[rgbaOffset + 1] = color.green;
  rgba[rgbaOffset + 2] = color.blue;
  rgba[rgbaOffset + 3] = color.alpha;
}
