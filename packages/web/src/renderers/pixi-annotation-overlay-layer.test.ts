import { describe, expect, it, vi } from "vitest";

import { createPixiAnnotationOverlayLayer } from "./pixi-annotation-overlay-layer";

describe("Pixi annotation overlay presentation", () => {
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
