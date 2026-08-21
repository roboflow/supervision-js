import { afterEach, describe, expect, it, vi } from "vitest";
import { readDemoMaskFrameOptions } from "./mask-raster-resolution";

function stage(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height }) as DOMRect,
  } as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDemoMaskFrameOptions", () => {
  it("says nothing unless the URL asks for display-sized masks", () => {
    vi.stubGlobal("devicePixelRatio", 2);

    expect(readDemoMaskFrameOptions(stage(1080, 854), 1.5, "")).toBeUndefined();
    expect(
      readDemoMaskFrameOptions(stage(1080, 854), 1.5, "?masks=native"),
    ).toBeUndefined();
  });

  it("hands over the stage box at the pixel ratio the canvas is drawn at", () => {
    vi.stubGlobal("devicePixelRatio", 2);

    expect(
      readDemoMaskFrameOptions(stage(1080, 854), 1.5, "?masks=display"),
    ).toEqual({
      display: {
        boxWidth: 1080,
        boxHeight: 854,
        devicePixelRatio: 2,
        maxDevicePixelRatio: 1.5,
      },
    });
  });

  it("sizes masks for the display even where the picture decodes native", () => {
    vi.stubGlobal("devicePixelRatio", 1);

    expect(
      readDemoMaskFrameOptions(
        stage(1080, 854),
        1.5,
        "?masks=display&decode=native",
      ),
    ).toEqual({
      display: {
        boxWidth: 1080,
        boxHeight: 854,
        devicePixelRatio: 1,
        maxDevicePixelRatio: 1.5,
      },
    });
  });

  it("says nothing about a stage that has not been laid out", () => {
    vi.stubGlobal("devicePixelRatio", 1);

    expect(
      readDemoMaskFrameOptions(stage(0, 854), 1.5, "?masks=display"),
    ).toBeUndefined();
  });
});
