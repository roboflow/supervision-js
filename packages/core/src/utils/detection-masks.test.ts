import { describe, expect, it } from "vitest";

import { decodeCompressedRleMask } from "#utils/detection-frames";
import {
  DetectionMaskPayloadFormat,
  computeDetectionMaskRect,
  computeMaskBounds,
  decodeDetectionMaskPayload,
  detectMaskBorders,
  encodeBinaryMask,
  encodeBinaryMaskWithBounds,
  encodeDetectionMaskPayload,
  extractDetectionMaskRectRuns,
  extractMaskContour,
  extractMaskRectRuns,
  isDeflatedBase64DetectionMaskPayload,
} from "#utils/detection-masks";

describe("detection mask utilities", () => {
  const data = Uint8Array.from([0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);

  it("round-trips row-major binary masks through COCO compressed RLE", () => {
    const mask = encodeBinaryMask(data, 4, 3);
    expect(decodeCompressedRleMask(mask).data).toEqual(data);
  });

  it("derives mask bounds while encoding the binary raster", () => {
    const result = encodeBinaryMaskWithBounds(data, 4, 3);

    expect(result.mask).toEqual(encodeBinaryMask(data, 4, 3));
    expect(result.bounds).toEqual({ height: 2, width: 2, x: 2, y: 1 });
    expect(
      encodeBinaryMaskWithBounds(new Uint8Array(12), 4, 3).bounds,
    ).toBeNull();
  });

  it("supports an injected transport compression codec", () => {
    const codec = {
      deflate: (value: string) => `encoded:${value}`,
      inflate: (value: string) => value.slice("encoded:".length),
    };
    const mask = encodeBinaryMask(data, 4, 3);
    const payload = encodeDetectionMaskPayload(mask, codec);

    expect(
      decodeDetectionMaskPayload(payload, 4, 3, {
        codec,
        format: DetectionMaskPayloadFormat.DeflatedBase64,
      }),
    ).toEqual(mask);
  });

  it("matches the editor's deflated payload heuristic", () => {
    expect(isDeflatedBase64DetectionMaskPayload("A".repeat(101))).toBe(true);
    expect(isDeflatedBase64DetectionMaskPayload("A".repeat(100))).toBe(false);
    expect(isDeflatedBase64DetectionMaskPayload(`${"A".repeat(100)}-`)).toBe(
      false,
    );
  });

  it("reads rect runs off a compressed mask without holding its raster", () => {
    const width = 10;
    const height = 8;
    const raster = new Uint8Array(width * height);

    for (let y = 2; y < height; y += 1) {
      raster[y * width + 7] = 1;
    }

    for (let y = 5; y < height; y += 1) {
      raster[y * width + 3] = 1;
    }

    const runs = extractDetectionMaskRectRuns(
      encodeBinaryMask(raster, width, height),
    );

    // Nothing touches the raster's first row or column, and the run that opens
    // later sits left of the one that opens first.
    expect(runs).toEqual([
      { height: 6, width: 1, x: 7, y: 2 },
      { height: 3, width: 1, x: 3, y: 5 },
    ]);
    expect(runs).toEqual(extractMaskRectRuns(raster, width, height));
    expect(
      extractDetectionMaskRectRuns(
        encodeBinaryMask(new Uint8Array(width * height), width, height),
      ),
    ).toBeUndefined();
  });

  it("reads the same mask rect as a pass over the decoded raster", () => {
    for (const [width, height] of [
      [23, 17],
      [1, 9],
      [9, 1],
      [640, 360],
    ] as const) {
      for (const raster of buildBoundsRasters(width, height)) {
        const mask = encodeBinaryMask(raster, width, height);
        const decoded = decodeCompressedRleMask(mask);

        expect(computeDetectionMaskRect(mask)).toEqual(
          computeMaskBounds(decoded.data, decoded.width, decoded.height) ??
            undefined,
        );
      }
    }
  });

  it("extracts bounds, borders, contours, and merged row runs", () => {
    expect(computeMaskBounds(data, 4, 3)).toEqual({
      height: 2,
      width: 2,
      x: 2,
      y: 1,
    });
    expect(Array.from(detectMaskBorders(data, 4, 3))).toEqual(Array.from(data));
    expect(extractMaskContour(data, 4, 3)).toHaveLength(4);
    expect(extractMaskRectRuns(data, 4, 3)).toEqual([
      { height: 2, width: 2, x: 1, y: 0 },
    ]);
  });
});

/**
 * Rasters chosen for where a COCO run can land: nothing, everything, each
 * corner alone, runs held inside one column, runs crossing into the next, and
 * scattered noise.
 */
function buildBoundsRasters(width: number, height: number) {
  const pixels = width * height;
  const rasters = [new Uint8Array(pixels), new Uint8Array(pixels).fill(1)];

  for (const x of [0, width - 1]) {
    for (const y of [0, height - 1]) {
      const corner = new Uint8Array(pixels);
      corner[y * width + x] = 1;
      rasters.push(corner);
    }
  }

  const column = new Uint8Array(pixels);
  const spanning = new Uint8Array(pixels);

  for (let y = 0; y < height; y += 1) {
    const x = Math.floor(width / 2);

    if (y > 0 && y < height - 1) {
      column[y * width + x] = 1;
    }

    spanning[y * width + x] = 1;
    spanning[y * width + Math.min(width - 1, x + 1)] = 1;
  }

  rasters.push(column, spanning);

  let seed = 0x2f6e2b1;

  for (let index = 0; index < 8; index += 1) {
    const noise = new Uint8Array(pixels);

    for (let offset = 0; offset < pixels; offset += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[offset] = seed % 32 === 0 ? 1 : 0;
    }

    rasters.push(noise);
  }

  return rasters;
}
