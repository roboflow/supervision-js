import { describe, expect, it } from "vitest";

import { DepthColormap } from "#types/depth-map";
import {
  createDepthColormapLut,
  depthColormapColors,
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
  it("builds 256 opaque RGBA entries for every colormap, and no others", () => {
    for (const name of Object.values(DepthColormap)) {
      const lut = createDepthColormapLut(name);

      expect(lut).toHaveLength(1024);
      for (let index = 0; index < 256; index += 1) {
        expect(lut[index * 4 + 3]).toBe(255);
      }
    }
    expect(isDepthColormap("jet")).toBe(false);
    expect(() => createDepthColormapLut("jet" as DepthColormap)).toThrow(
      RangeError,
    );
  });

  it("uses Google's published Turbo table and matplotlib's tables", () => {
    for (const [name, index, rgba] of [
      ["turbo", 0, [48, 18, 59, 255]],
      ["turbo", 255, [122, 4, 3, 255]],
      ["viridis", 0, [68, 1, 84, 255]],
      ["viridis", 255, [253, 231, 37, 255]],
      ["cividis", 0, [0, 34, 78, 255]],
      ["inferno", 255, [252, 255, 164, 255]],
      ["magma", 255, [252, 253, 191, 255]],
      ["grayscale", 128, [128, 128, 128, 255]],
    ] as const) {
      expect(entry(createDepthColormapLut(name), index), name).toEqual(rgba);
    }
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
});

describe("depth colormap colours", () => {
  it("samples the renderer's table far end first, near end last", () => {
    const [r, g, b] = entry(createDepthColormapLut("magma"), 128);

    expect(depthColormapColors("turbo", 3)).toEqual([
      "#30123b",
      expect.any(String),
      "#7a0403",
    ]);
    expect(depthColormapColors("magma", 3)[1]).toBe(
      `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`,
    );
    expect(depthColormapColors("grayscale", 2)).toEqual(["#000000", "#ffffff"]);
    expect(depthColormapColors("viridis")).toHaveLength(16);
  });

  it("rejects an unknown colormap and a stop count outside 2 to 256", () => {
    expect(() => depthColormapColors("jet" as never)).toThrow(RangeError);
    expect(() => depthColormapColors("turbo", 1)).toThrow(
      "Depth colormap stops must be an integer from 2 to 256, got 1.",
    );
    expect(() => depthColormapColors("turbo", 2.5)).toThrow(RangeError);
    expect(() => depthColormapColors("turbo", 257)).toThrow(RangeError);
  });
});
