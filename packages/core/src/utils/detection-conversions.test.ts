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
} from "#utils/detection-conversions";

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
