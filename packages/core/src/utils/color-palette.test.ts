import { describe, expect, it } from "vitest";

import {
  normalizeDetectionClassName,
  resolveDetectionClassColorStyle,
} from "./color-palette";

describe("color palette helpers", () => {
  it("normalizes class names before resolving known styles", () => {
    expect(resolveDetectionClassColorStyle("CELL_PHONE")).toEqual(
      resolveDetectionClassColorStyle("cell phone"),
    );
    expect(normalizeDetectionClassName(" potted_plant ")).toBe("potted plant");
  });

  it("keeps common live classes visually distinct", () => {
    const fills = ["tv", "cup", "keyboard", "bed", "laptop", "knife"].map(
      (className) => resolveDetectionClassColorStyle(className).fill,
    );

    expect(new Set(fills).size).toBe(fills.length);
  });

  it("uses stable fallback colors for unknown class names", () => {
    expect(resolveDetectionClassColorStyle("traffic cone")).toEqual(
      resolveDetectionClassColorStyle("traffic_cone"),
    );
  });
});
