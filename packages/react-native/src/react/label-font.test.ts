import { describe, expect, it } from "vitest";

import {
  resolveReactNativeSkiaDefaultFontFamily,
  resolveReactNativeSkiaLabelFontStyle,
} from "./label-font";

describe("resolveReactNativeSkiaDefaultFontFamily", () => {
  it("uses a generic family Android's font manager can resolve", () => {
    expect(resolveReactNativeSkiaDefaultFontFamily("android")).toBe(
      "sans-serif",
    );
  });

  it("keeps the CoreText system family everywhere else", () => {
    expect(resolveReactNativeSkiaDefaultFontFamily("ios")).toBe("System");
  });
});

describe("resolveReactNativeSkiaLabelFontStyle", () => {
  it("keeps the primary family and weight from a core label style", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle(
        {
          color: 0xffffff,
          fontFamily: '"Avenir Next", sans-serif',
          fontSize: 16,
          fontWeight: 600,
        },
        "ios",
      ),
    ).toEqual({
      fontFamily: "Avenir Next",
      fontSize: 16,
      fontWeight: "600",
    });
  });

  it("normalizes named weights and falls back to the platform family", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle(
        {
          color: 0xffffff,
          fontWeight: "semibold",
        },
        "android",
      ),
    ).toEqual({
      fontFamily: "sans-serif",
      fontSize: 13,
      fontWeight: "600",
    });
  });

  it("falls back to the native normal weight for an unsupported value", () => {
    expect(
      resolveReactNativeSkiaLabelFontStyle(
        {
          color: 0xffffff,
          fontWeight: "variable",
        },
        "ios",
      ),
    ).toEqual({
      fontFamily: "System",
      fontSize: 13,
      fontWeight: "normal",
    });
  });
});
