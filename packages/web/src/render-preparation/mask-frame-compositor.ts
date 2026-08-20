import { IdMaskRasterFormat } from "#render-preparation/mask-frame-artifact";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
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

/** WebGL uploads texture rows on a four-byte alignment. */
const TEXTURE_ROW_ALIGNMENT_BYTES = 4;

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

export interface IdMaskRasterFrame extends IdMaskFrame {
  readonly rasterFormat: IdMaskRasterFormat;
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
): IdMaskRasterFrame | undefined {
  try {
    return buildIdMaskRasterFrame(instructions);
  } catch {
    // The id raster is the fast path, not the only one: answering with nothing
    // puts the caller on the RGBA composite, which draws the same picture.
    return undefined;
  }
}

function buildIdMaskRasterFrame(
  instructions: readonly SerializableMaskInstruction[],
): IdMaskRasterFrame | undefined {
  const frame = createIdMaskFrame(materializeMaskInstructions(instructions));

  if (!frame) {
    return undefined;
  }

  if (frame.width % TEXTURE_ROW_ALIGNMENT_BYTES === 0) {
    return { ...frame, rasterFormat: IdMaskRasterFormat.R8 };
  }

  return {
    ...frame,
    data: expandIdsToRgba(frame.data),
    rasterFormat: IdMaskRasterFormat.Rgba8,
  };
}

function expandIdsToRgba(ids: Uint8Array): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8Array(new ArrayBuffer(ids.length * 4));

  for (let index = 0; index < ids.length; index += 1) {
    rgba[index * 4] = ids[index] ?? 0;
    rgba[index * 4 + 3] = 0xff;
  }

  return rgba;
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
  return instructions.map((instruction) => {
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
