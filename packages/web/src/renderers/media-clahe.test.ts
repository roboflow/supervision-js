import { describe, expect, it } from "vitest";
import { computeMediaClahe } from "./media-clahe";

function grayscale(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      rgba.fill(pixel(x, y), offset, offset + 3);
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

describe("media Auto contrast", () => {
  it("expands local low contrast without amplifying a flat image or changing another tile", () => {
    const width = 512;
    const height = 512;
    const rgba = grayscale(width, height, (x, y) => 100 + ((x + y * 7) % 41));
    const original = computeMediaClahe(rgba, width, height);
    expect(original.tilesX).toBe(8);
    expect(original.tilesY).toBe(8);
    for (let tile = 0; tile < 64; tile++) {
      const lut = original.luts.subarray(tile * 256, (tile + 1) * 256);
      expect(lut[140]! - lut[100]!).toBeGreaterThan(80);
      expect(lut[255]).toBe(255);
      expect(
        Array.from(lut).every((value, i) => i === 0 || value >= lut[i - 1]!),
      ).toBe(true);
    }
    const flat = computeMediaClahe(
      grayscale(width, height, () => 100),
      width,
      height,
    );
    expect(Math.abs(flat.luts[100]! - 100)).toBeLessThanOrEqual(3);

    const changed = computeMediaClahe(
      grayscale(width, height, (x, y) =>
        x < 64 ? 200 : 100 + ((x + y * 7) % 41),
      ),
      width,
      height,
    );
    expect(changed.luts.subarray(0, 256)).not.toEqual(
      original.luts.subarray(0, 256),
    );
    expect(changed.luts.subarray(256, 512)).toEqual(
      original.luts.subarray(256, 512),
    );
  });

  it("uses Rec.601 intensity and keeps tiny images' lookup tables valid", () => {
    const red = computeMediaClahe(
      new Uint8ClampedArray([255, 0, 0, 255]),
      1,
      1,
    );
    expect(red.luts[75]).toBe(0);
    expect(red.luts[76]).toBe(255);
    const tiny = computeMediaClahe(
      grayscale(3, 2, (x, y) => 10 + x * 10 + y * 30),
      3,
      2,
    );
    expect([tiny.tilesX, tiny.tilesY]).toEqual([3, 2]);
    for (let tile = 0; tile < 6; tile++)
      expect(tiny.luts[tile * 256 + 255]).toBe(255);
  });
});
