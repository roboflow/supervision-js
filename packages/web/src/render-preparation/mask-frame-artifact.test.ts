import { describe, expect, it } from "vitest";

import {
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
  type PreparedIdMaskFrame,
} from "./mask-frame-artifact";

/** Odd width and unequal sides, so a stride or axis error cannot come out even. */
const WIDTH = 3;
const HEIGHT = 2;
/** Row-major ids, all distinct, so a misread returns another detection's id. */
const IDS = [11, 12, 13, 14, 15, 16];

function createFrame(raster: Uint8Array<ArrayBuffer>): PreparedIdMaskFrame {
  return {
    close() {},
    fillPalette: new Float32Array(new ArrayBuffer(0)),
    hasStroke: false,
    height: HEIGHT,
    key: "frame",
    kind: PreparedMaskFrameKind.IdMask,
    maxStrokeWidth: 0,
    raster,
    sourceWidth: WIDTH,
    strokePalette: new Float32Array(new ArrayBuffer(0)),
    strokeWidths: new Float32Array(new ArrayBuffer(0)),
    width: WIDTH,
  };
}

function createRaster() {
  const raster = new Uint8Array(new ArrayBuffer(WIDTH * HEIGHT));

  IDS.forEach((id, pixelOffset) => {
    raster[pixelOffset] = id;
  });

  return raster;
}

function readAll(frame: PreparedIdMaskFrame) {
  const values: number[] = [];

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      values.push(readIdMaskRasterValue(frame, x, y));
    }
  }

  return values;
}

describe("readIdMaskRasterValue", () => {
  it("reads an odd-width raster one byte per pixel", () => {
    expect(readAll(createFrame(createRaster()))).toEqual(IDS);
  });

  it("strides by the frame's own width rather than a padded one", () => {
    const frame = createFrame(createRaster());
    // What the second row would read at a four-byte-aligned stride.
    const paddedStrideRow = [4, 5, 6].map(
      (offset) => frame.raster[offset] ?? 0,
    );

    expect(paddedStrideRow).toEqual([15, 16, 0]);
    expect(readAll(frame).slice(WIDTH)).toEqual([14, 15, 16]);
  });

  it("answers zero outside the raster rather than undefined", () => {
    expect(readIdMaskRasterValue(createFrame(createRaster()), 0, HEIGHT)).toBe(
      0,
    );
  });
});
