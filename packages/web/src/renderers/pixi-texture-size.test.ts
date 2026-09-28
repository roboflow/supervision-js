import { describe, expect, it } from "vitest";

import { fitTextureSize, resolveMaxTextureSize } from "./pixi-texture-size";

const MAX_TEXTURE_SIZE = 0x0d33;

function webglRenderer(limit: number) {
  return {
    gl: {
      MAX_TEXTURE_SIZE,
      getParameter: (name: number) => (name === MAX_TEXTURE_SIZE ? limit : 0),
    },
  };
}

describe("fitTextureSize", () => {
  it("keeps media that fits, including a side exactly at the limit", () => {
    expect(fitTextureSize(16384, 3000, 16384)).toEqual({
      height: 3000,
      width: 16384,
    });
    expect(fitTextureSize(5472, 3648, 16384)).toEqual({
      height: 3648,
      width: 5472,
    });
  });

  it("scales the longest side to the limit and keeps the aspect ratio", () => {
    expect(fitTextureSize(20000, 3000, 16384)).toEqual({
      height: 2458,
      width: 16384,
    });
    expect(fitTextureSize(5000, 30000, 16384)).toEqual({
      height: 16384,
      width: 2731,
    });
  });

  it("never stages a side of zero or above the limit", () => {
    expect(fitTextureSize(60000, 1, 4096)).toEqual({ height: 1, width: 4096 });
    expect(fitTextureSize(16385, 16385, 16384)).toEqual({
      height: 16384,
      width: 16384,
    });
  });

  it("treats an unknown limit as no limit", () => {
    expect(fitTextureSize(20000, 3000, Infinity)).toEqual({
      height: 3000,
      width: 20000,
    });
  });
});

describe("resolveMaxTextureSize", () => {
  it("reads the WebGL limit", () => {
    expect(resolveMaxTextureSize(webglRenderer(16384), undefined)).toBe(16384);
  });

  it("reads the WebGPU device limit", () => {
    const renderer = {
      gpu: { device: { limits: { maxTextureDimension2D: 8192 } } },
    };
    expect(resolveMaxTextureSize(renderer, undefined)).toBe(8192);
  });

  it("lets the caller lower the limit but never raise it", () => {
    expect(resolveMaxTextureSize(webglRenderer(16384), 4096)).toBe(4096);
    expect(resolveMaxTextureSize(webglRenderer(16384), 32768)).toBe(16384);
    expect(resolveMaxTextureSize({}, 4096)).toBe(4096);
  });

  it("has no limit when neither the renderer nor the caller names one", () => {
    expect(resolveMaxTextureSize({}, undefined)).toBe(Infinity);
  });
});
