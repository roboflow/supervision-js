import { describe, expect, it } from "vitest";

import { DetectionMaskEncoding } from "supervision-js-core";

import {
  compositeMaskFrame,
  createIdMaskFrame,
  createPngIdMaskFrame,
} from "./mask-frame-compositor";

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("mask frame compositor", () => {
  it("encodes style-indexed ID masks as PNG artifacts", async () => {
    const frame = await createPngIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1, 3]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.png.slice(0, 8)]).toEqual(pngSignature);
    expect([...frame!.data]).toEqual([1, 0, 0, 0]);
  });

  it("builds detection-indexed ID mask artifacts for shader rendering and picking", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1, 2]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
        stroke: {
          alpha: 1,
          color: 0xffffff,
          width: 1,
        },
      },
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 1,
        mask: {
          counts: encodeCompressedRleCounts([1, 1, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
        stroke: {
          alpha: 1,
          color: 0xffffff,
          width: 1,
        },
      },
      {
        alpha: 0.25,
        color: 0x00ff00,
        detectionIndex: 2,
        mask: {
          counts: encodeCompressedRleCounts([2, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.data]).toEqual([1, 2, 3]);
    expect([...frame!.fillPalette.slice(4, 16)]).toEqual([
      1, 0, 0, 0.5, 1, 0, 0, 0.5, 0, 1, 0, 0.25,
    ]);
    expect([...frame!.strokePalette.slice(4, 16)]).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
    ]);
    expect([...frame!.strokeWidths.slice(1, 4)]).toEqual([1, 1, 0]);
    expect(frame!.maxStrokeWidth).toBe(1);
    expect(frame!.hasStroke).toBe(true);
  });

  it("keeps thick mask strokes on the PNG ID-mask path", async () => {
    const frame = await createPngIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1, 3]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
        stroke: {
          alpha: 1,
          color: 0x00ffff,
          width: 5,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.png.slice(0, 8)]).toEqual(pngSignature);
    expect(frame!.hasStroke).toBe(true);
    expect(frame!.maxStrokeWidth).toBe(5);
    expect(frame!.strokeWidths[1]).toBe(5);
    expect([...frame!.strokePalette.slice(4, 8)]).toEqual([0, 1, 1, 1]);
  });

  it("composites mask strokes into the prepared frame artifact", () => {
    const frame = compositeMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
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
