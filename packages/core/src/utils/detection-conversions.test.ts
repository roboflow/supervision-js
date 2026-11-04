import { describe, expect, it } from "vitest";

import type { Detection } from "#types/detections";
import { decodeCompressedRleMask } from "#utils/detection-frames";
import {
  convertDetectionBoxToMask,
  convertDetectionBoxToPolygon,
  convertDetectionMaskToBox,
  convertDetectionMaskToPolygon,
  convertDetectionPolygonToBox,
  convertDetectionPolygonToMask,
  mergeDetectionMasks,
  mergeDetectionPolygonsByClass,
  rasterizePolygonToMask,
} from "#utils/detection-conversions";
import { encodeBinaryMask } from "#utils/detection-masks";

describe("detection geometry conversions", () => {
  const box: Detection = {
    className: "car",
    id: "box",
    rect: { height: 4, width: 6, x: 2, y: 3 },
  };

  it("converts boxes and polygons without changing base fields", () => {
    const polygon = convertDetectionBoxToPolygon(box);
    expect(polygon.id).toBe("box");
    expect(polygon.polygon?.points).toEqual([
      { x: -1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 5 },
      { x: -1, y: 5 },
    ]);
    expect(convertDetectionPolygonToBox(polygon).rect).toEqual(box.rect);
  });

  it("rasterizes boxes and polygons into semantic COCO RLE masks", () => {
    const boxMask = convertDetectionBoxToMask(box, { height: 12, width: 12 });
    expect(decodeCompressedRleMask(boxMask.mask!).data.some(Boolean)).toBe(
      true,
    );
    expect(convertDetectionMaskToBox(boxMask).rect).toBeDefined();

    const polygonMask = convertDetectionPolygonToMask(
      convertDetectionBoxToPolygon(box),
      { height: 12, width: 12 },
    );
    expect(
      convertDetectionMaskToPolygon(polygonMask).polygon?.points.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    {
      height: 8,
      name: "two rows",
      on: (x: number, y: number) => y >= 2 && y < 4 && x < 5,
      width: 8,
    },
    {
      height: 8,
      name: "one column",
      on: (x: number, y: number) => x === 3 && y < 6,
      width: 8,
    },
    {
      height: 12,
      name: "triangle",
      on: (x: number, y: number) => x <= y,
      width: 12,
    },
    { height: 10, name: "full frame", on: () => true, width: 10 },
    { height: 1000, name: "sampled rows", on: () => true, width: 20 },
    {
      height: 1000,
      name: "partly sampled rows",
      on: (_: number, y: number) => y >= 3 && y < 996,
      width: 20,
    },
    {
      height: 1000,
      name: "tapered sampled rows",
      on: (x: number, y: number) =>
        y >= 95 && y < 212 && Math.abs(x - 120) <= y - 95,
      width: 240,
    },
  ])(
    "keeps the extent of a $name mask as a polygon",
    ({ height, on, width }) => {
      const raster = Uint8Array.from({ length: width * height }, (_, index) =>
        on(index % width, Math.floor(index / width)) ? 1 : 0,
      );
      const detection: Detection = {
        id: "mask",
        mask: encodeBinaryMask(raster, width, height),
      };

      const polygon = convertDetectionMaskToPolygon(detection);

      expect(convertDetectionPolygonToBox(polygon).rect).toEqual(
        convertDetectionMaskToBox(detection).rect,
      );
      expect(
        rasterizePolygonToMask(polygon.polygon!.points, { height, width }),
      ).toEqual(raster);
    },
  );

  it("does not stretch a contour to a stray blob between sampled rows", () => {
    const width = 20;
    const height = 1000;
    const raster = Uint8Array.from({ length: width * height }, (_, index) => {
      const y = Math.floor(index / width);
      return (y >= 3 && y < 5) || (y >= 500 && y < 600) ? 1 : 0;
    });

    const polygon = convertDetectionMaskToPolygon({
      id: "mask",
      mask: encodeBinaryMask(raster, width, height),
    });

    expect(convertDetectionPolygonToBox(polygon).rect).toEqual({
      height: 100,
      width: 20,
      x: 10,
      y: 550,
    });
  });

  it("rasterizes polygons from their top-left bounds", () => {
    const polygonMask = convertDetectionPolygonToMask(
      {
        id: "offset-polygon",
        polygon: {
          points: [
            { x: 1, y: 1 },
            { x: 4, y: 1 },
            { x: 4, y: 4 },
            { x: 1, y: 4 },
          ],
        },
      },
      { height: 6, width: 6 },
    );
    const pixels = decodeCompressedRleMask(polygonMask.mask!).data;

    expect(pixels[2 * 6 + 2]).toBe(1);
    expect(pixels[4 * 6 + 4]).toBe(0);
  });

  it("merges same-class masks", () => {
    const first = convertDetectionBoxToMask(box, { height: 20, width: 20 });
    const second = convertDetectionBoxToMask(
      { ...box, id: "second", rect: { height: 2, width: 2, x: 12, y: 12 } },
      { height: 20, width: 20 },
    );

    expect(mergeDetectionMasks([first, second])?.id).toBe("box");
    expect(
      mergeDetectionMasks([first, { ...second, className: "person" }]),
    ).toBeNull();
  });

  it("merges polygon groups into class bounding boxes", () => {
    const merged = mergeDetectionPolygonsByClass([
      convertDetectionBoxToPolygon(box),
      convertDetectionBoxToPolygon({
        ...box,
        id: "second",
        rect: { height: 2, width: 2, x: 10, y: 10 },
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.rect).toEqual({ height: 10, width: 12, x: 5, y: 6 });
  });

  it("preserves exact rectangle dimensions and parity between box and polygon rasterization", () => {
    const sampleBox: Detection = {
      id: "square-3x3",
      rect: { height: 3, width: 3, x: 2.5, y: 2.5 },
    };
    const dimensions = { height: 10, width: 10 };

    const boxMask = convertDetectionBoxToMask(sampleBox, dimensions);
    const polyMask = convertDetectionPolygonToMask(
      convertDetectionBoxToPolygon(sampleBox),
      dimensions,
    );

    const boxPixels = decodeCompressedRleMask(boxMask.mask!).data;
    const polyPixels = decodeCompressedRleMask(polyMask.mask!).data;

    // Both must match bit-for-bit.
    expect(boxPixels).toEqual(polyPixels);

    // 3x3 rectangle centered at (2.5, 2.5) covers [1, 4) in x and y (exactly 9 pixels).
    const activePixelCount = boxPixels.filter((pixel) => pixel === 1).length;
    expect(activePixelCount).toBe(9);

    // Pixel boundaries: indices (1,1) to (3,3) are active; (4,4) is outside.
    expect(boxPixels[1 * 10 + 1]).toBe(1);
    expect(boxPixels[3 * 10 + 3]).toBe(1);
    expect(boxPixels[4 * 10 + 4]).toBe(0);

    // Converting mask back to box recovers original exact geometry without expansion.
    const recovered = convertDetectionMaskToBox(boxMask);
    expect(recovered.rect).toEqual(sampleBox.rect);
  });
});
