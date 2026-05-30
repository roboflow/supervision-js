import { describe, expect, it } from "vitest";

import { DetectionMaskEncoding } from "#types/detections";

import { compositeMaskFrame } from "./mask-frame-compositor";

describe("mask frame compositor", () => {
  it("composites mask strokes into the prepared frame artifact", () => {
    const frame = compositeMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        mask: {
          counts: encodeCompressedRleCounts([12, 1, 12]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 5,
          width: 5,
        },
        stroke: {
          alpha: 1,
          color: 0x0066ff,
          width: 1,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect(readPixel(frame!.data, 5, 2, 2)).toEqual([255, 0, 0, 128]);
    expect(readPixel(frame!.data, 5, 2, 1)).toEqual([0, 102, 255, 255]);
    expect(readPixel(frame!.data, 5, 1, 2)).toEqual([0, 102, 255, 255]);
    expect(readPixel(frame!.data, 5, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

function readPixel(
  data: Uint8ClampedArray,
  canvasWidth: number,
  x: number,
  y: number,
) {
  const offset = (y * canvasWidth + x) * 4;

  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function encodeCompressedRleCounts(counts: readonly number[]) {
  return counts
    .map((count, index) => {
      let value = index > 2 ? count - counts[index - 2]! : count;
      let encoded = "";
      let more = true;

      while (more) {
        let charCode = value & 0x1f;

        value >>= 5;
        more = !(
          (value === 0 && (charCode & 0x10) === 0) ||
          (value === -1 && (charCode & 0x10) !== 0)
        );

        if (more) {
          charCode |= 0x20;
        }

        encoded += String.fromCharCode(charCode + 48);
      }

      return encoded;
    })
    .join("");
}
