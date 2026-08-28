import { describe, expect, it } from "vitest";

import {
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";

import {
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
  type PreparedIdMaskFrame,
} from "./mask-frame-artifact";
import {
  compositeMaskFrame,
  createIdMaskFrame,
  createIdMaskPlane,
  createIdMaskRasterFrame,
  createRegionMaskCoverageFrame,
} from "./mask-frame-compositor";

describe("mask frame compositor", () => {
  it("carries an unaligned ID raster one byte per pixel", () => {
    const frame = createIdMaskRasterFrame([
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
    expect([...frame!.data]).toEqual([1, 0, 0, 0]);
  });

  it("keeps an odd-width ID raster pickable", () => {
    const frame = createIdMaskRasterFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([1, 2, 3]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 3,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect(frame!.data.length).toBe(3 * 2);

    const prepared: PreparedIdMaskFrame = {
      close() {},
      fillPalette: frame!.fillPalette,
      hasStroke: frame!.hasStroke,
      height: frame!.height,
      key: "odd",
      kind: PreparedMaskFrameKind.IdMask,
      maxStrokeWidth: frame!.maxStrokeWidth,
      raster: frame!.data,
      strokePalette: frame!.strokePalette,
      strokeWidths: frame!.strokeWidths,
      width: frame!.width,
    };
    const picked: number[] = [];

    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        picked.push(readIdMaskRasterValue(prepared, x, y));
      }
    }

    // Compressed RLE runs down columns, so the two mask pixels of run [1, 2]
    // are (0,1) and (1,0).
    expect(picked).toEqual([0, 1, 0, 1, 0, 0]);
  });

  it("hands an aligned ID raster to the GPU one byte per pixel", () => {
    const frame = createIdMaskRasterFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1, 3]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 4,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.data]).toEqual([1, 0, 0, 0]);
  });

  it("rasterizes polygons into worker-preparable ID-mask artifacts", () => {
    const frame = createIdMaskRasterFrame([
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

  it("caps the ID plane the RGBA composite carries", () => {
    const instructions = [
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 32]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 4,
          width: 8,
        },
      },
    ];
    const plane = createIdMaskPlane(instructions, 4);

    expect(plane).toEqual({
      data: new Uint8Array(8).fill(1),
      height: 2,
      width: 4,
    });
    expect(createIdMaskPlane(instructions)).toMatchObject({
      height: 4,
      width: 8,
    });
  });

  it("keeps thick mask strokes on the ID-mask path", () => {
    const frame = createIdMaskRasterFrame([
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

  it("leaves a coverage-only instruction out of the ID raster too", () => {
    const mask = {
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
        mask,
        regionCoverageMask: mask,
        visible: false,
      },
    ] as const;

    // Both representations read the same instruction list, so the filter has
    // to sit where they share it or one of them paints the invisible mask.
    expect(createIdMaskRasterFrame(instructions)).toBeUndefined();
    expect(compositeMaskFrame(instructions)).toBeUndefined();
    expect(createRegionMaskCoverageFrame(instructions)?.entries).toHaveLength(
      1,
    );
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
