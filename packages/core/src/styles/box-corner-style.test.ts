import { describe, expect, it } from "vitest";

import { BaseBoxCornerStyle } from "#styles/box-corner-style";
import type { Detection } from "#types/detections";

const detection: Detection = {
  rect: { height: 40, width: 60, x: 100, y: 80 },
};
const context = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
  viewportScale: 2,
};

describe("BaseBoxCornerStyle", () => {
  it("keeps configured screen lengths stable across viewport scale", () => {
    const style = new BaseBoxCornerStyle({ length: 20 });

    expect(style.resolve(detection, context)?.segments[0]).toEqual([
      { x: 80, y: 60 },
      { x: 70, y: 60 },
      { x: 70, y: 70 },
    ]);
  });

  it("does not draw when hidden or when its length is zero", () => {
    const style = new BaseBoxCornerStyle({ length: 0 });

    expect(style.resolve(detection, context)).toBeUndefined();
    expect(
      new BaseBoxCornerStyle().resolve(detection, { ...context, hidden: true }),
    ).toBeUndefined();
  });
});
