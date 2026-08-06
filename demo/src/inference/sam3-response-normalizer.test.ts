import { describe, expect, it } from "vitest";
import { encodeBinaryMask } from "supervision/editing";

import { normalizeSam3Detections } from "./sam3-response-normalizer";

describe("SAM3 response normalization", () => {
  it("derives center-based rectangles from polygons", () => {
    const [detection] = normalizeSam3Detections(
      {
        predictions: [
          {
            polygon: [
              [10, 20],
              [30, 20],
              [30, 60],
              [10, 60],
            ],
          },
        ],
      },
      ["object"],
    );

    expect(detection?.rect).toEqual({
      height: 40,
      width: 20,
      x: 20,
      y: 40,
    });
  });

  it("derives center-based rectangles from RLE masks", () => {
    const mask = encodeBinaryMask(
      Uint8Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0]),
      4,
      3,
    );
    const [detection] = normalizeSam3Detections({ predictions: [{ mask }] }, [
      "object",
    ]);

    expect(detection?.rect).toEqual({
      height: 2,
      width: 2,
      x: 2,
      y: 2,
    });
  });
});
