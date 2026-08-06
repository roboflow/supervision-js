import { describe, expect, it } from "vitest";

import { resolveReactNativeSkiaLabelFontStyle } from "./label-font";

describe("resolveReactNativeSkiaLabelFontStyle", () => {
  it("keeps the primary family and weight from a core label style", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle({
        color: 0xffffff,
        fontFamily: '"Avenir Next", sans-serif',
        fontSize: 16,
        fontWeight: 600,
      }),
    ).toEqual({
      fontFamily: "Avenir Next",
      fontSize: 16,
      fontWeight: "600",
    });
  });

  it("normalizes named weights without inventing a font family", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle({
        color: 0xffffff,
        fontWeight: "semibold",
      }),
    ).toEqual({ fontSize: 13, fontWeight: "600" });
  });

  it("falls back to the native normal weight for an unsupported value", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle({
        color: 0xffffff,
        fontWeight: "variable",
      }),
    ).toEqual({ fontSize: 13, fontWeight: "normal" });
  });
});
