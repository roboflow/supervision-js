import { describe, expect, it, vi } from "vitest";

import { ShapeInstructionKind } from "supervision-js-core";
import { resolveAnnotationShapeStyle } from "#renderers/annotation-shape-styles";
import type { Detection, EllipseStyleContext } from "supervision-js-core";

const detection: Detection = {
  className: "player",
  rect: { height: 40, width: 30, x: 10, y: 20 },
};
const context: EllipseStyleContext = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
};

describe("annotation shape styles", () => {
  it("returns no shape style when no shape-backed kind is configured", () => {
    expect(resolveAnnotationShapeStyle({})).toBeNull();
    expect(resolveAnnotationShapeStyle({ ellipseStyle: null })).toBeNull();
  });

  it("lowers resolved ellipse instructions into the shape vocabulary", () => {
    const style = resolveAnnotationShapeStyle({
      ellipseStyle: {
        resolve: () => ({
          center: { x: 25, y: 60 },
          endAngle: 2,
          radiusX: 15,
          radiusY: 5,
          startAngle: -1,
          stroke: { alpha: 1, color: 0x123456, width: 2 },
        }),
      },
    });

    expect(style?.resolve(detection, context)).toEqual([
      {
        center: { x: 25, y: 60 },
        endAngle: 2,
        kind: ShapeInstructionKind.Ellipse,
        radiusX: 15,
        radiusY: 5,
        startAngle: -1,
        stroke: { alpha: 1, color: 0x123456, width: 2 },
      },
    ]);
  });

  it("skips detections the ellipse style resolves to nothing", () => {
    const resolve = vi.fn(() => undefined);
    const style = resolveAnnotationShapeStyle({ ellipseStyle: { resolve } });

    expect(style?.resolve(detection, context)).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith(detection, context);
  });
});
