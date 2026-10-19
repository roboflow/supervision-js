import { describe, expect, it, vi } from "vitest";

import {
  DetectionMaskEncoding,
  encodeCompressedRleCounts,
} from "supervision-js-core";

const idMaskFailure = new RangeError("Array buffer allocation failed");

vi.mock("supervision-js-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("supervision-js-core")>();

  return {
    ...core,
    createIdMaskFrame: () => {
      throw idMaskFailure;
    },
  };
});

const instructions = [
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
];

describe("mask frame compositor under an ID raster failure", () => {
  it("answers with nothing rather than throwing", async () => {
    const { createIdMaskRasterFrame } = await import("./mask-frame-compositor");

    expect(createIdMaskRasterFrame(instructions)).toBeUndefined();
  });

  it("leaves the RGBA composite able to draw the same frame", async () => {
    const { compositeMaskFrame } = await import("./mask-frame-compositor");
    const frame = compositeMaskFrame(instructions);

    expect(frame).toBeDefined();
    expect(frame!.width).toBe(2);
    expect(frame!.height).toBe(2);
    expect([...frame!.data.slice(0, 4)]).toEqual([255, 0, 0, 128]);
  });
});
