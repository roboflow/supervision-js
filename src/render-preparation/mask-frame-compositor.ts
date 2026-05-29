import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import { decodeCompressedRleMask } from "#utils/detection-frames";

export interface CompositedMaskFrame {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly height: number;
  readonly width: number;
}

export function compositeMaskFrame(
  instructions: readonly SerializableMaskInstruction[],
): CompositedMaskFrame | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...instructions.map(({ mask }) => mask.width));
  const height = Math.max(...instructions.map(({ mask }) => mask.height));
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (const instruction of instructions) {
    compositeInstruction(data, width, instruction);
  }

  return { data, height, width };
}

function compositeInstruction(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  instruction: SerializableMaskInstruction,
) {
  const decodedMask = decodeCompressedRleMask(instruction.mask);
  const red = (instruction.color >> 16) & 0xff;
  const green = (instruction.color >> 8) & 0xff;
  const blue = instruction.color & 0xff;
  const alpha = Math.round(Math.max(0, Math.min(instruction.alpha, 1)) * 255);

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const maskOffset = y * decodedMask.width + x;

      if (!decodedMask.data[maskOffset]) {
        continue;
      }

      const rgbaOffset = (y * canvasWidth + x) * 4;
      rgba[rgbaOffset] = red;
      rgba[rgbaOffset + 1] = green;
      rgba[rgbaOffset + 2] = blue;
      rgba[rgbaOffset + 3] = alpha;
    }
  }
}
