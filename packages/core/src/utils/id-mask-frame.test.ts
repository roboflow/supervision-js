import { describe, expect, it } from "vitest";

import { DetectionMaskEncoding } from "#types/detections";
import { encodeCompressedRleCounts } from "#utils/detection-frames";
import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  createIdMaskFrame,
} from "#utils/id-mask-frame";

describe("id mask frame artifacts", () => {
  it("encodes detection ids and lets later detections render on top", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 0.5,
        color: 0xff0000,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 2]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
      },
      {
        alpha: 0.25,
        color: 0x00ff00,
        detectionIndex: 1,
        mask: {
          counts: encodeCompressedRleCounts([1, 1, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 3,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect([...frame!.data]).toEqual([1, 2, 0]);
    expect([...frame!.fillPalette.slice(4, 12)]).toEqual([
      1, 0, 0, 0.5, 0, 1, 0, 0.25,
    ]);
  });

  it("preserves stroke palettes and clamps stroke widths", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 1,
        color: 0x336699,
        detectionIndex: 0,
        mask: {
          counts: encodeCompressedRleCounts([0, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 1,
        },
        stroke: {
          alpha: 0.75,
          color: 0xffffff,
          width: MAX_ID_MASK_STROKE_WIDTH + 10,
        },
      },
    ]);

    expect(frame).toBeDefined();
    expect(frame!.hasStroke).toBe(true);
    expect(frame!.maxStrokeWidth).toBe(MAX_ID_MASK_STROKE_WIDTH);
    expect(frame!.strokeWidths[1]).toBe(MAX_ID_MASK_STROKE_WIDTH);
    expect([...frame!.strokePalette.slice(4, 8)]).toEqual([1, 1, 1, 0.75]);
  });

  it("rejects artifacts that exceed the shader palette capacity", () => {
    const frame = createIdMaskFrame([
      {
        alpha: 1,
        color: 0xffffff,
        detectionIndex: MAX_ID_MASK_PALETTE_ENTRIES,
        mask: {
          counts: encodeCompressedRleCounts([0, 1]),
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 1,
        },
      },
    ]);

    expect(frame).toBeUndefined();
  });
});
