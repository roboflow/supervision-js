import type { MaskDrawInstruction } from "#types/mask-style";
import { decodeCompressedRleCounts } from "#utils/detection-frames";

export const MAX_ID_MASK_PALETTE_ENTRIES = 64;
export const MAX_ID_MASK_STROKE_WIDTH = 16;

export interface IdMaskInstruction extends MaskDrawInstruction {
  readonly detectionIndex: number;
}

export interface IdMaskFrame {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly fillPalette: Float32Array<ArrayBuffer>;
  readonly hasStroke: boolean;
  readonly height: number;
  readonly maxStrokeWidth: number;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly strokeWidths: Float32Array<ArrayBuffer>;
  readonly width: number;
}

export function createIdMaskFrame(
  instructions: readonly IdMaskInstruction[],
): IdMaskFrame | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...instructions.map(({ mask }) => mask.width));
  const height = Math.max(...instructions.map(({ mask }) => mask.height));
  const data = new Uint8Array(new ArrayBuffer(width * height));
  const fillPalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokePalette = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4 * 4),
  );
  const strokeWidths = new Float32Array(
    new ArrayBuffer(MAX_ID_MASK_PALETTE_ENTRIES * 4),
  );
  let hasStroke = false;
  let maxStrokeWidth = 0;

  for (const instruction of instructions) {
    const detectionMaskId = instruction.detectionIndex + 1;

    if (
      detectionMaskId <= 0 ||
      detectionMaskId >= MAX_ID_MASK_PALETTE_ENTRIES
    ) {
      return undefined;
    }

    writePaletteEntry(
      fillPalette,
      detectionMaskId,
      instruction.color,
      instruction.alpha,
    );

    if (instruction.stroke && instruction.stroke.width > 0) {
      const strokeWidth = Math.min(
        Math.max(0, instruction.stroke.width),
        MAX_ID_MASK_STROKE_WIDTH,
      );

      hasStroke = true;
      strokeWidths[detectionMaskId] = strokeWidth;
      maxStrokeWidth = Math.max(maxStrokeWidth, strokeWidth);
      writePaletteEntry(
        strokePalette,
        detectionMaskId,
        instruction.stroke.color,
        instruction.stroke.alpha,
      );
    }

    writeMaskRuns(data, width, instruction.mask, detectionMaskId);
  }

  return {
    data,
    fillPalette,
    hasStroke,
    height,
    maxStrokeWidth,
    strokePalette,
    strokeWidths,
    width,
  };
}

/**
 * Compressed RLE counts runs down each column in turn, so a foreground run is
 * a contiguous walk down one column that wraps into the next.
 */
function writeMaskRuns(
  data: Uint8Array,
  frameWidth: number,
  mask: IdMaskInstruction["mask"],
  detectionMaskId: number,
) {
  const counts = decodeCompressedRleCounts(mask.counts);
  const maskWidth = mask.width;
  const maskHeight = mask.height;
  let maskOffset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;

    if (index % 2 === 0 || runLength <= 0) {
      maskOffset += runLength;
      continue;
    }

    let x = Math.floor(maskOffset / maskHeight);
    let y = maskOffset - x * maskHeight;
    let frameOffset = y * frameWidth + x;

    for (let step = 0; step < runLength; step += 1) {
      if (x >= maskWidth) {
        break;
      }

      data[frameOffset] = detectionMaskId;
      y += 1;
      frameOffset += frameWidth;

      if (y === maskHeight) {
        y = 0;
        x += 1;
        frameOffset = x;
      }
    }

    maskOffset += runLength;
  }
}

function writePaletteEntry(
  palette: Float32Array,
  id: number,
  color: number,
  alpha: number,
) {
  const offset = id * 4;

  palette[offset] = ((color >> 16) & 0xff) / 255;
  palette[offset + 1] = ((color >> 8) & 0xff) / 255;
  palette[offset + 2] = (color & 0xff) / 255;
  palette[offset + 3] = Math.max(0, Math.min(alpha, 1));
}
