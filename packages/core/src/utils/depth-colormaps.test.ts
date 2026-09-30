import { describe, expect, it } from "vitest";

import { DepthColormap } from "#types/depth-map";
import {
  createDepthColormapLut,
  isDepthColormap,
} from "#utils/depth-colormaps";

const entry = (lut: Uint8Array, index: number) =>
  Array.from(lut.subarray(index * 4, index * 4 + 4));

/** CIE L* of an sRGB colour, which is what "monotonic in lightness" means. */
function lightness([r, g, b]: number[]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

  return luminance > 216 / 24389
    ? 116 * Math.cbrt(luminance) - 16
    : (24389 / 27) * luminance;
}

describe("depth colour tables", () => {
  it("builds 256 opaque RGBA entries for every colormap", () => {
    for (const name of Object.values(DepthColormap)) {
      const lut = createDepthColormapLut(name);

      expect(lut).toHaveLength(1024);
      for (let index = 0; index < 256; index += 1) {
        expect(lut[index * 4 + 3]).toBe(255);
      }
    }
  });

  it("uses Google's published Turbo table, not a polynomial fit", () => {
    const lut = createDepthColormapLut("turbo");

    expect(entry(lut, 0)).toEqual([48, 18, 59, 255]);
    expect(entry(lut, 255)).toEqual([122, 4, 3, 255]);
  });

  it("matches matplotlib's tables at their ends", () => {
    expect(entry(createDepthColormapLut("viridis"), 0)).toEqual([
      68, 1, 84, 255,
    ]);
    expect(entry(createDepthColormapLut("viridis"), 255)).toEqual([
      253, 231, 37, 255,
    ]);
    expect(entry(createDepthColormapLut("cividis"), 0)).toEqual([
      0, 34, 78, 255,
    ]);
    expect(entry(createDepthColormapLut("inferno"), 255)).toEqual([
      252, 255, 164, 255,
    ]);
    expect(entry(createDepthColormapLut("magma"), 255)).toEqual([
      252, 253, 191, 255,
    ]);
    expect(entry(createDepthColormapLut("grayscale"), 128)).toEqual([
      128, 128, 128, 255,
    ]);
  });

  it("rises in lightness wherever the map is meant to", () => {
    for (const name of [
      "viridis",
      "cividis",
      "inferno",
      "magma",
      "grayscale",
    ] as const) {
      const lut = createDepthColormapLut(name);
      let previous = -Infinity;

      for (let index = 0; index < 256; index += 1) {
        const current = lightness(entry(lut, index));

        // Eight-bit rounding dents Viridis and Cividis by a few hundredths of L*.
        expect(current, `${name} entry ${index}`).toBeGreaterThan(
          previous - 0.1,
        );
        previous = current;
      }
    }
  });

  it("rejects unknown names", () => {
    expect(isDepthColormap("jet")).toBe(false);
    expect(() => createDepthColormapLut("jet" as DepthColormap)).toThrow(
      RangeError,
    );
  });
});
