import type { MaskDrawInstruction } from "#types/mask-style";
import { decodeDetectionMask } from "#utils/detection-frames";

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

    const decodedMask = decodeDetectionMask(instruction.mask);

    for (let y = 0; y < decodedMask.height; y += 1) {
      for (let x = 0; x < decodedMask.width; x += 1) {
        const maskOffset = y * decodedMask.width + x;

        if (decodedMask.data[maskOffset]) {
          data[y * width + x] = detectionMaskId;
        }
      }
    }
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
