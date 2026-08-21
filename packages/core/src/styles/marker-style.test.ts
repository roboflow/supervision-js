import { describe, expect, it } from "vitest";

import { BaseMarkerStyle } from "#styles/marker-style";
import { MarkerShape, MarkerSizeSpace } from "#types/shape-style";
import type { Detection } from "#types/detections";

const detection: Detection = {
  rect: { height: 40, width: 60, x: 100, y: 80 },
};
const context = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
};

describe("BaseMarkerStyle", () => {
  it("uses the detection rectangle center with screen-space circle defaults", () => {
    expect(new BaseMarkerStyle().resolve(detection, context)).toMatchObject({
      center: { x: 100, y: 80 },
      shape: MarkerShape.Circle,
      size: 12,
      sizeSpace: MarkerSizeSpace.Screen,
    });
  });

  it("accepts a semantic custom anchor and all built-in marker shapes", () => {
    const marker = new BaseMarkerStyle({
      center: { x: 12, y: 20 },
      fill: null,
      shape: MarkerShape.Cross,
      size: 18,
      sizeSpace: MarkerSizeSpace.Media,
    });

    expect(marker.resolve(detection, context)).toMatchObject({
      center: { x: 12, y: 20 },
      shape: MarkerShape.Cross,
      size: 18,
      sizeSpace: MarkerSizeSpace.Media,
    });
  });

  it("allows closed markers to opt into a fill-only treatment", () => {
    expect(
      new BaseMarkerStyle({
        fill: { alpha: 0.4, color: 0xff8800 },
        shape: MarkerShape.Triangle,
        stroke: null,
      }).resolve(detection, context),
    ).toMatchObject({
      fill: { alpha: 0.4, color: 0xff8800 },
      shape: MarkerShape.Triangle,
    });
  });

  it("does not emit invisible closed markers or stroke-less crosses", () => {
    expect(
      new BaseMarkerStyle({ fill: null, stroke: null }).resolve(
        detection,
        context,
      ),
    ).toBeUndefined();
    expect(
      new BaseMarkerStyle({ shape: MarkerShape.Cross, stroke: null }).resolve(
        detection,
        context,
      ),
    ).toBeUndefined();
  });

  it("does not render hidden detections or invalid sizes", () => {
    expect(
      new BaseMarkerStyle().resolve(detection, { ...context, hidden: true }),
    ).toBeUndefined();
    expect(
      new BaseMarkerStyle({ size: 0 }).resolve(detection, context),
    ).toBeUndefined();
  });
});
