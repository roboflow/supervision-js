import { describe, expect, it } from "vitest";

import { DepthMapKind, type DepthMap } from "#types/depth-map";
import { readDepthAt } from "#utils/depth-readout";

/** A 4x2 disparity map at scale 256; fx * B = 100. */
const disparityMap: DepthMap = {
  camera: { baselineM: 0.1, fxPx: 1000 },
  confidence: Uint8Array.from([255, 0, 51, 102, 153, 204, 255, 0]),
  height: 2,
  kind: DepthMapKind.DisparityPx,
  samples: {
    encoding: "scaled16",
    scale: 256,
    values: Uint16Array.from([
      0,
      256 * 10,
      256 * 20,
      256 * 25,
      256 * 50,
      256 * 100,
      128,
      65_535,
    ]),
  },
  width: 4,
};

describe("depth readout", () => {
  it("reads the map pixel under a media point, with its confidence scaled to 0..1", () => {
    // Media 400x200 over a 4x2 map: (250, 150) lands on map pixel (2, 1).
    const readout = readDepthAt(
      disparityMap,
      { x: 250, y: 150 },
      { height: 200, width: 400 },
    );

    expect(readout).toMatchObject({
      confidence: 1,
      disparityPx: 0.5,
      precision: "exact",
      stored: 128,
      valid: true,
      x: 2,
      y: 1,
    });
    expect(readout?.depthM).toBeCloseTo(200, 9);
    // Without a coordinate space the point is in map pixels.
    expect(readDepthAt(disparityMap, { x: 1.9, y: 0.2 })).toMatchObject({
      depthM: 10,
      disparityPx: 10,
      step: 1 / 256,
      x: 1,
      y: 0,
    });
    expect(readDepthAt(disparityMap, { x: 2, y: 0 })?.confidence).toBeCloseTo(
      0.2,
      9,
    );
    expect(readDepthAt(disparityMap, { x: 3, y: 1 })?.confidence).toBe(0);
  });

  it("returns null outside the map", () => {
    for (const point of [
      { x: -0.01, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 2 },
      { x: Number.NaN, y: 0 },
    ]) {
      expect(readDepthAt(disparityMap, point)).toBeNull();
    }
    expect(
      readDepthAt(disparityMap, { x: 400, y: 0 }, { height: 200, width: 400 }),
    ).toBeNull();
    expect(
      readDepthAt(disparityMap, { x: 1, y: 1 }, { height: 0, width: 0 }),
    ).toBeNull();
  });

  it("marks a stored 0 as no depth and reports nothing else", () => {
    expect(readDepthAt(disparityMap, { x: 0, y: 0 })).toEqual({
      confidence: 1,
      precision: "exact",
      step: 1 / 256,
      stored: 0,
      valid: false,
      x: 0,
      y: 0,
    });
  });

  it("converts between disparity and metres only where the camera allows", () => {
    const metric: DepthMap = {
      ...disparityMap,
      kind: DepthMapKind.DepthM,
      samples: {
        encoding: "scaled16",
        scale: 1000,
        values: new Uint16Array(8).fill(2000),
      },
    };
    const relative = readDepthAt(
      {
        ...disparityMap,
        camera: undefined,
        kind: DepthMapKind.RelativeInverse,
      },
      { x: 1, y: 0 },
    );

    expect(readDepthAt(disparityMap, { x: 2, y: 0 })?.depthM).toBeCloseTo(5, 9);
    expect(
      readDepthAt(
        { ...disparityMap, camera: { ...disparityMap.camera!, doffsPx: 30 } },
        { x: 2, y: 0 },
      )?.depthM,
    ).toBeCloseTo(2, 9);
    expect(
      readDepthAt({ ...disparityMap, camera: undefined }, { x: 2, y: 0 }),
    ).not.toHaveProperty("depthM");
    expect(readDepthAt(metric, { x: 3, y: 1 })).toMatchObject({
      depthM: 2,
      disparityPx: 50,
      step: 0.001,
    });
    expect(
      readDepthAt({ ...metric, camera: undefined }, { x: 3, y: 1 }),
    ).not.toHaveProperty("disparityPx");
    expect(relative).toMatchObject({ relativeInverse: 10, valid: true });
    expect(relative).not.toHaveProperty("depthM");
    expect(relative).not.toHaveProperty("disparityPx");
  });

  it("decodes full- and TV-range preview codes and their step", () => {
    const preview = (
      levels: "full" | "tv",
      reservedMax: number,
      max: number,
      codes: number[],
    ): DepthMap => ({
      height: 1,
      kind: DepthMapKind.DisparityPx,
      samples: {
        encoding: "preview8",
        levels,
        range: { max, min: 0 },
        reservedMax,
        values: Uint8Array.from(codes),
      },
      width: codes.length,
    });
    const full = preview("full", 15, 192, [15, 16, 135, 255]);
    const step = 192 / 239;

    expect(readDepthAt(full, { x: 0, y: 0 })).toMatchObject({
      precision: "preview",
      stored: 15,
      valid: false,
    });
    expect(readDepthAt(full, { x: 1, y: 0 })?.disparityPx).toBe(0);
    expect(readDepthAt(full, { x: 2, y: 0 })?.disparityPx).toBeCloseTo(
      119 * step,
      9,
    );
    expect(readDepthAt(full, { x: 3, y: 0 })).toMatchObject({
      disparityPx: 192,
      precision: "preview",
    });
    expect(readDepthAt(full, { x: 3, y: 0 })?.step).toBeCloseTo(step, 12);

    // TV range tops out at 235 and reads the headroom above it as the top.
    const tv = preview("tv", 31, 63, [16, 32, 235, 250]);

    expect(readDepthAt(tv, { x: 0, y: 0 })?.valid).toBe(false);
    expect(readDepthAt(tv, { x: 1, y: 0 })?.disparityPx).toBe(0);
    expect(readDepthAt(tv, { x: 2, y: 0 })).toMatchObject({
      disparityPx: 63,
      step: 63 / 203,
    });
    expect(readDepthAt(tv, { x: 3, y: 0 })?.disparityPx).toBe(63);
  });
});
