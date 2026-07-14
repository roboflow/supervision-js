import { describe, expect, it } from "vitest";

import { decodeCompressedRleMask } from "#utils/detection-frames";
import {
  DetectionMaskPayloadFormat,
  computeMaskBounds,
  decodeDetectionMaskPayload,
  detectMaskBorders,
  encodeBinaryMask,
  encodeDetectionMaskPayload,
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
