import { describe, expect, it, vi } from "vitest";

import { createPixiAnnotationOverlayLayer } from "./pixi-annotation-overlay-layer";

describe("Pixi annotation overlay presentation", () => {
  it("resolves selection handles from each selected annotation", () => {
    const graphics = {
      circle: vi.fn(),
      clear: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
    };
    const frame = {
      detections: [
        {
          className: "purple",
          id: "purple-1",
          rect: { height: 20, width: 20, x: 20, y: 20 },
        },
        {
          className: "green",
          id: "green-1",
          rect: { height: 20, width: 20, x: 60, y: 20 },
        },
      ],
      mediaTime: 0,
    };
    const layer = createPixiAnnotationOverlayLayer(undefined, {
      selectionHandle: {
        fill: (detection) => ({
          alpha: 1,
          color: detection.className === "purple" ? 0x9333ea : 0x22c55e,
        }),
        stroke: { alpha: 0, color: 0, width: 0 },
      },
    });

    layer.attachGraphics(graphics as never);
    layer.draw({
      frame,
      marquee: null,
      mediaHeight: 100,
      mediaWidth: 100,
      now: 0,
      pointer: null,
      selectedDetectionIds: ["purple-1", "green-1"],
      viewportScale: 1,
    });

    expect(graphics.fill).toHaveBeenNthCalledWith(1, {
      alpha: 1,
      color: 0x9333ea,
    });
    expect(graphics.fill).toHaveBeenNthCalledWith(9, {
      alpha: 1,
      color: 0x22c55e,
    });
  });

  it("uses renderer-neutral preview colors and strokes", () => {
    const graphics = {
      clear: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      poly: vi.fn(),
      stroke: vi.fn(),
    };
    graphics.poly.mockReturnValue(graphics);
    const layer = createPixiAnnotationOverlayLayer(undefined, {
      externalPreview: {
        hoverFill: { alpha: 0.4, color: 0x112233 },
        hoverStroke: { alpha: 0.9, color: 0x445566, width: 6 },
      },
    });

    layer.attachGraphics(graphics as never);
    layer.draw({
      frame: undefined,
      marquee: null,
      mediaHeight: 100,
      mediaWidth: 100,
      now: 0,
      pointer: null,
      previewOverlay: {
        hoverPolygons: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
        ],
      },
      selectedDetectionIds: [],
      viewportScale: 2,
    });

    expect(graphics.fill).toHaveBeenCalledWith({
      alpha: 0.4,
      color: 0x112233,
    });
    expect(graphics.stroke).toHaveBeenCalledWith({
      alpha: 0.9,
      color: 0x445566,
      width: 3,
    });
  });
});
