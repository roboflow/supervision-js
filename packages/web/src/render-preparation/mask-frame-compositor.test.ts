import { describe, expect, it } from "vitest";

import {
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";

import {
  compositeMaskFrame,
  createIdMaskFrame,
  createPngIdMaskFrame,
  createRegionMaskCoverageFrame,
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

  it("rasterizes polygons into worker-preparable ID-mask artifacts", async () => {
    const frame = await createPngIdMaskFrame([
      {
        alpha: 0.25,
        color: 0x00ff00,
        detectionIndex: 2,
        polygon: {
          height: 6,
          points: [
            { x: 1, y: 1 },
            { x: 4, y: 1 },
            { x: 4, y: 4 },
            { x: 1, y: 4 },
          ],
          width: 6,
        },
        stroke: {
          alpha: 1,
          color: 0xffffff,
          width: 2,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect(frame!.data[2 * 6 + 2]).toBe(3);
    expect(frame!.data[4 * 6 + 4]).toBe(0);
    expect(frame!.fillPalette.slice(12, 16)).toEqual(
      Float32Array.from([0, 1, 0, 0.25]),
    );
    expect(frame!.strokeWidths[3]).toBe(2);
  });

  it("strokes a dense mask whose foreground bytes are 255, not 1", () => {
    // A model producer publishes its own bytes, and 0/255 is the common shape.
    // Comparing foreground against `1` used to be safe because every decoded
    // mask came from the RLE decoder, which writes a literal 1.
    const composite = (value: number) =>
      compositeMaskFrame([
        {
          alpha: 1,
          color: 0xff0000,
          detectionIndex: 0,
          mask: {
            // 4x4 with a 2x2 block in the middle, so it has a real boundary.
            data: new Uint8Array([
              0,
              0,
              0,
              0,
              0,
              value,
              value,
              0,
              0,
              value,
              value,
              0,
              0,
              0,
              0,
              0,
            ]),
            encoding: DetectionMaskEncoding.DenseBitmap,
            height: 4,
            width: 4,
          },
          stroke: { alpha: 1, color: 0x00ff00, width: 1 },
        },
      ]);

    const ones = composite(1);
    const full = composite(255);

    expect(full).toBeDefined();
    // Identical geometry must produce an identical composite regardless of
    // which non-zero value the producer chose.
    expect([...full!.data]).toEqual([...ones!.data]);

    // The stroke color must actually be written somewhere, not silently lost.
    const strokePixels = [...full!.data]
      .filter((_, index) => index % 4 === 1)
      .filter((green) => green > 0);

    expect(strokePixels.length).toBeGreaterThan(0);
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

  it("preserves overlapping exact-region masks independently of detection indexes", () => {
    const mask = {
      counts: encodeCompressedRleCounts([0, 1]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 1,
      width: 1,
    } as const;
    const frame = createRegionMaskCoverageFrame([
      {
        alpha: 0,
        color: 0,
        detectionIndex: 0,
        mask,
        regionCoverageMask: mask,
      },
      {
        alpha: 0,
        color: 0,
        detectionIndex: 63,
        mask,
        regionCoverageMask: mask,
      },
    ]);

    expect(frame?.entries).toEqual([
      {
        data: Uint8Array.from([255]),
        detectionIndex: 0,
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
      {
        data: Uint8Array.from([255]),
        detectionIndex: 63,
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
    ]);
  });

  it("does not impose a renderer target limit", () => {
    const mask = {
      counts: encodeCompressedRleCounts([0, 1]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 1,
      width: 1,
    } as const;
    const frame = createRegionMaskCoverageFrame(
      Array.from({ length: 25 }, (_, detectionIndex) => ({
        alpha: 0,
        color: 0,
        detectionIndex,
        mask,
        regionCoverageMask: mask,
      })),
    );

    expect(frame?.entries).toHaveLength(25);
    expect(frame?.entries[24]).toMatchObject({
      detectionIndex: 24,
    });
  });

  it("keeps Region coverage separate from visible mask composition", () => {
    const visibleMask = {
      counts: encodeCompressedRleCounts([0, 1]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 1,
      width: 2,
    } as const;
    const semanticCoverageMask = {
      counts: encodeCompressedRleCounts([1, 1]),
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 1,
      width: 2,
    } as const;
    const instructions = [
      {
        alpha: 1,
        color: 0xff0000,
        detectionIndex: 0,
        mask: visibleMask,
        regionCoverageMask: semanticCoverageMask,
      },
      {
        alpha: 0,
        color: 0,
        detectionIndex: 1,
        mask: semanticCoverageMask,
        regionCoverageMask: semanticCoverageMask,
        visible: false,
      },
    ] as const;

    const composited = compositeMaskFrame(instructions);
    const coverage = createRegionMaskCoverageFrame(instructions);

    expect(composited?.data).toEqual(
      Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 0, 0]),
    );
    expect(coverage?.entries).toEqual([
      expect.objectContaining({
        data: Uint8Array.from([255]),
        detectionIndex: 0,
        x: 1,
      }),
      expect.objectContaining({
        data: Uint8Array.from([255]),
        detectionIndex: 1,
        x: 1,
      }),
    ]);
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
