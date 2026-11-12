import { describe, expect, it } from "vitest";
import { encodeBinaryMask, rasterizePolygonToMask } from "supervision-js-core";
import {
  createPackedMaskCoverage,
  createPackedPolygonCoverage,
  readPackedMaskCoverage,
} from "./packed-mask-coverage";

describe("independent packed mask coverage", () => {
  it.each([1, 7, 8, 9, 31, 32, 33, 75])(
    "preserves every foreground pixel and hole at width %s",
    (width) => {
      const height = 57;
      const pixels = Uint8Array.from({ length: width * height }, (_, index) => {
        const x = index % width;
        const y = Math.floor(index / width);
        return Number(
          x >= 2 && x < width - 2 && y >= 20 && y < 25 && (x + y) % 3 !== 0,
        );
      });
      const coverage = createPackedMaskCoverage(
        encodeBinaryMask(pixels, width, height),
        300,
      );
      if (!pixels.some(Boolean)) {
        expect(coverage).toBeUndefined();
        return;
      }
      expect(coverage!.detectionIndex).toBe(300);
      expect(coverage!.textureWidth % 4).toBe(0);
      for (let y = -1; y <= height; y += 1) {
        for (let x = -1; x <= width; x += 1) {
          expect(readPackedMaskCoverage(coverage!, x, y)).toBe(
            x >= 0 &&
              y >= 0 &&
              x < width &&
              y < height &&
              Boolean(pixels[y * width + x]),
          );
        }
      }
    },
  );

  it.each([
    [
      { x: 4, y: 3 },
      { x: 30, y: 3 },
      { x: 30, y: 19 },
      { x: 4, y: 19 },
    ],
    [
      { x: -6.25, y: 2.75 },
      { x: 20.5, y: -3 },
      { x: 41.75, y: 17.25 },
      { x: 9.5, y: 23.5 },
    ],
  ])(
    "covers exactly the pixels the id raster cooks for polygon %#",
    (...points) => {
      const polygon = { height: 22, points, width: 37 };
      const pixels = rasterizePolygonToMask(points, polygon);
      const coverage = createPackedPolygonCoverage(polygon, 2)!;

      expect(coverage.detectionIndex).toBe(2);
      expect(coverage.textureWidth % 4).toBe(0);
      for (let y = -1; y <= polygon.height; y += 1) {
        for (let x = -1; x <= polygon.width; x += 1) {
          expect(readPackedMaskCoverage(coverage, x, y)).toBe(
            x >= 0 &&
              y >= 0 &&
              x < polygon.width &&
              y < polygon.height &&
              pixels[y * polygon.width + x] === 1,
          );
        }
      }
    },
  );

  it("keeps overlapping masks independent with one bit per pixel", () => {
    const width = 1024;
    const height = 1024;
    const mask = encodeBinaryMask(
      new Uint8Array(width * height).fill(1),
      width,
      height,
    );
    const entries = Array.from({ length: 100 }, (_, index) =>
      createPackedMaskCoverage(mask, index)!,
    );
    expect(entries.reduce((sum, entry) => sum + entry.data.byteLength, 0)).toBe(
      (100 * width * height) / 8,
    );
    expect(
      entries.every((entry) => readPackedMaskCoverage(entry, 511, 511)),
    ).toBe(true);
    // No annotation index is encoded into the coverage bits.
    expect(entries[0]!.data).toEqual(entries[99]!.data);
  });
});
