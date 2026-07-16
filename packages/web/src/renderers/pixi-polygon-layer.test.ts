import { describe, expect, it } from "vitest";

import { BasePolygonStyle, BoxStrokeAlignment } from "supervision-js-core";
import {
  canPreparePolygonInstruction,
  resolvePreparedPolygonInstructions,
} from "./pixi-polygon-layer";

const points = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
];

describe("pixi polygon layer", () => {
  it("prepares solid center-aligned polygons as raster artifacts", () => {
    expect(
      canPreparePolygonInstruction({
        fill: { alpha: 0.25, color: 0xff0000 },
        points,
        stroke: {
          alignment: BoxStrokeAlignment.Center,
          alpha: 1,
          color: 0xffffff,
          width: 3,
        },
      }),
    ).toBe(true);
  });

  it("keeps unsupported stroke semantics on the vector fallback", () => {
    expect(
      canPreparePolygonInstruction({
        points,
        stroke: {
          alpha: 1,
          color: 0xffffff,
          dash: [4, 2],
          width: 3,
        },
      }),
    ).toBe(false);
    expect(
      canPreparePolygonInstruction({
        points,
        stroke: {
          alignment: BoxStrokeAlignment.Outside,
          alpha: 1,
          color: 0xffffff,
          width: 3,
        },
      }),
    ).toBe(false);
  });

  it("resolves ordered worker instructions with screen-space stroke widths", () => {
    const frame = {
      detections: [
        { id: "front", polygon: { points }, zIndex: 2 },
        { id: "back", polygon: { points }, zIndex: 1 },
      ],
      frameIndex: 4,
      mediaTime: 2,
    };
    const instructions = resolvePreparedPolygonInstructions({
      frame,
      mediaHeight: 50,
      mediaTime: 2,
      mediaWidth: 100,
      polygonStyle: new BasePolygonStyle({
        fill: { alpha: 0.2, color: 0xff0000 },
        stroke: { alpha: 1, color: 0xffffff, width: 6 },
      }),
      viewportScale: 2,
    });

    expect(instructions.map(({ detectionIndex }) => detectionIndex)).toEqual([
      1, 0,
    ]);
    expect(instructions[0]).toMatchObject({
      alpha: 0.2,
      color: 0xff0000,
      polygon: { height: 50, points, width: 100 },
      stroke: { alpha: 1, color: 0xffffff, width: 3 },
    });
  });
});
