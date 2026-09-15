import { afterEach, describe, expect, it, vi } from "vitest";
import { readDemoDisplayBox } from "./decode-resolution";

function stage(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height }) as DOMRect,
  } as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDemoDisplayBox", () => {
  it("caps the decode at the pixel ratio the canvas is drawn at", () => {
    vi.stubGlobal("devicePixelRatio", 2);

    expect(readDemoDisplayBox(stage(1080, 854), 1.5, "")).toEqual({
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 2,
      maxDevicePixelRatio: 1.5,
    });
  });

  it("leaves the pixel ratio uncapped when the renderer caps nothing", () => {
    vi.stubGlobal("devicePixelRatio", 3);

    expect(readDemoDisplayBox(stage(1080, 854), undefined, "")).toEqual({
      boxWidth: 1080,
      boxHeight: 854,
      devicePixelRatio: 3,
      maxDevicePixelRatio: 3,
    });
  });

  it("says nothing about a stage that has not been laid out", () => {
    expect(readDemoDisplayBox(stage(0, 854), 1.5, "")).toBeUndefined();
  });

  it("says nothing when the URL asks for native decoding", () => {
    expect(
      readDemoDisplayBox(stage(1080, 854), 1.5, "?decode=native"),
    ).toBeUndefined();
  });
});
