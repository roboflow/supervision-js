import { describe, expect, it } from "vitest";
import type { Detection } from "#types/detections";
import {
  BasePercentageBarStyle,
  PercentageBarPlacement,
} from "#styles/percentage-bar-style";

const detection: Detection = {
  className: "person",
  confidence: 0.85,
  id: "d1",
  rect: { height: 100, width: 60, x: 100, y: 100 },
};

const context = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
  viewportScale: 1,
};

describe("BasePercentageBarStyle", () => {
  it("resolves default percentage bar geometry from detection confidence", () => {
    const style = new BasePercentageBarStyle();
    const instruction = style.resolve(detection, context);

    expect(instruction).toBeDefined();
    expect(instruction?.value).toBe(0.85);

    // Default bar height is 8, placement Top.
    // Detection top is y - height/2 = 100 - 50 = 50.
    // Bar top is 50 - 8 = 42. Bar center y is 42 + 4 = 46.
    expect(instruction?.backgroundRect).toEqual({
      height: 8,
      width: 60,
      x: 100,
      y: 46,
    });

    // Value rect width is 60 * 0.85 = 51.
    // Left edge is 100 - 30 = 70. Center x is 70 + 51/2 = 95.5.
    expect(instruction?.valueRect).toEqual({
      height: 8,
      width: 51,
      x: 95.5,
      y: 46,
    });

    expect(instruction?.background?.color).toBe(0x0f172a);
    expect(instruction?.fill?.alpha).toBe(1);
  });

  it("clamps values outside [0, 1]", () => {
    const style = new BasePercentageBarStyle({ value: 1.5 });
    const instruction = style.resolve(detection, context);
    expect(instruction?.value).toBe(1);
    expect(instruction?.valueRect.width).toBe(60);

    const styleLow = new BasePercentageBarStyle({ value: -0.2 });
    const instructionLow = styleLow.resolve(detection, context);
    expect(instructionLow?.value).toBe(0);
    expect(instructionLow?.valueRect.width).toBe(0);
  });

  it("supports bottom and inside placements", () => {
    const bottomStyle = new BasePercentageBarStyle({
      placement: PercentageBarPlacement.Bottom,
    });
    const bottomInstruction = bottomStyle.resolve(detection, context);
    // Detection bottom is 100 + 50 = 150.
    // Bar top is 150. Bar center y is 150 + 4 = 154.
    expect(bottomInstruction?.backgroundRect.y).toBe(154);

    const insideTopStyle = new BasePercentageBarStyle({
      placement: PercentageBarPlacement.InsideTop,
    });
    const insideTopInstruction = insideTopStyle.resolve(detection, context);
    // Detection top is 50. Bar center y is 50 + 4 = 54.
    expect(insideTopInstruction?.backgroundRect.y).toBe(54);

    const insideBottomStyle = new BasePercentageBarStyle({
      placement: PercentageBarPlacement.InsideBottom,
    });
    const insideBottomInstruction = insideBottomStyle.resolve(
      detection,
      context,
    );
    // Detection bottom is 150. Bar top is 150 - 8 = 142. Bar center y is 142 + 4 = 146.
    expect(insideBottomInstruction?.backgroundRect.y).toBe(146);
  });

  it("honors shouldRender predicate and hidden context", () => {
    const hiddenStyle = new BasePercentageBarStyle();
    expect(
      hiddenStyle.resolve(detection, { ...context, hidden: true }),
    ).toBeUndefined();

    const skippedStyle = new BasePercentageBarStyle({
      shouldRender: (d) => d.id !== "d1",
    });
    expect(skippedStyle.resolve(detection, context)).toBeUndefined();
  });
});
