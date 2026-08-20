import { describe, expect, it } from "vitest";

import {
  IdMaskRasterFormat,
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
  type PreparedIdMaskFrame,
} from "./mask-frame-artifact";

/** Odd width and unequal sides, so a stride or axis error cannot come out even. */
const WIDTH = 3;
const HEIGHT = 2;
/** Row-major ids, all distinct, so a misread returns another detection's id. */
const IDS = [11, 12, 13, 14, 15, 16];

function createFrame(
  rasterFormat: IdMaskRasterFormat,
  raster: Uint8Array<ArrayBuffer>,
): PreparedIdMaskFrame {
  return {
    close() {},
    fillPalette: new Float32Array(new ArrayBuffer(0)),
    hasStroke: false,
    height: HEIGHT,
    key: "frame",
    kind: PreparedMaskFrameKind.IdMask,
    maxStrokeWidth: 0,
    raster,
    rasterFormat,
    strokePalette: new Float32Array(new ArrayBuffer(0)),
    strokeWidths: new Float32Array(new ArrayBuffer(0)),
    width: WIDTH,
  };
}

function createSingleChannelRaster() {
  const raster = new Uint8Array(new ArrayBuffer(WIDTH * HEIGHT));

  IDS.forEach((id, pixelOffset) => {
    raster[pixelOffset] = id;
  });

  return raster;
}

function createFourChannelRaster() {
  const raster = new Uint8Array(new ArrayBuffer(WIDTH * HEIGHT * 4));

  IDS.forEach((id, pixelOffset) => {
    raster[pixelOffset * 4] = id;
    raster[pixelOffset * 4 + 3] = 0xff;
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
  it("reads an odd-width single-channel raster one byte per pixel", () => {
    const frame = createFrame(
      IdMaskRasterFormat.R8,
      createSingleChannelRaster(),
    );

    expect(readAll(frame)).toEqual(IDS);
  });

  it("reads an odd-width four-channel raster from the red channel", () => {
    const frame = createFrame(
      IdMaskRasterFormat.Rgba8,
      createFourChannelRaster(),
    );

    expect(readAll(frame)).toEqual(IDS);
  });

  it("takes the stride from the format rather than the raster length", () => {
    const raster = createFourChannelRaster();
    // Ids a single-channel read would return from the four-channel raster.
    const decoys = [raster[0], raster[1], raster[2], raster[3]];

    expect(decoys).toEqual([11, 0, 0, 255]);
    expect(
      readAll(createFrame(IdMaskRasterFormat.Rgba8, raster)).slice(0, 4),
    ).toEqual([11, 12, 13, 14]);
  });
});
