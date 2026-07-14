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
});
