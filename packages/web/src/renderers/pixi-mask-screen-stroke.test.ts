import { describe, expect, it, vi } from "vitest";
import {
  PreparedMaskFrameKind,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import { createPixiMaskScreenStrokeRenderer } from "#renderers/pixi-mask-screen-stroke";

describe("screen-space mask strokes", () => {
  it.each([2, 3.5])(
    "keeps a %i CSS-pixel stroke at every zoom and raster size",
    (width) => {
      const renderer = createPixiMaskScreenStrokeRenderer({
        Graphics: FakeGraphics as never,
        mediaWidth: 1920,
        mediaHeight: 1280,
      });
      const graphics = renderer.display as unknown as FakeGraphics;
      for (const rasterWidth of [60, 1920]) {
        const frame = outlineFrame(rasterWidth, width);
        for (const scale of [0.125, 0.5, 1, 4]) {
          renderer.render(frame, scale);
          const stroke = graphics.stroke.mock.lastCall![0];
          expect(stroke.width * scale).toBeCloseTo(width);
          expect(stroke.alpha).toBe(1);
        }
      }
    },
  );

  it("reuses the prepared boundary and redraws it only when presentation changes", () => {
    const renderer = createPixiMaskScreenStrokeRenderer({
      Graphics: FakeGraphics as never,
      mediaWidth: 120,
      mediaHeight: 80,
    });
    const graphics = renderer.display as unknown as FakeGraphics;
    const frame = outlineFrame(60, 2);
    renderer.render(frame, 0.5);
    renderer.render(frame, 0.5);
    expect(graphics.clear).toHaveBeenCalledTimes(1);
    expect(graphics.moveTo).toHaveBeenCalledWith(20, 20);
    renderer.render(frame, 0.5, [
      {
        detectionIndex: 0,
        stroke: {
          alpha: 0.65,
          color: 0x00ff00,
          width: 3.5,
          widthUnit: "screen",
        },
      },
    ]);
    expect(graphics.stroke.mock.lastCall![0]).toMatchObject({
      alpha: 0.65,
      color: 0x00ff00,
      width: 7,
    });
    renderer.hide();
    expect(graphics.visible).toBe(false);
    renderer.destroy();
    expect(graphics.destroy).toHaveBeenCalledOnce();
  });
});

function outlineFrame(width: number, strokeWidth: number): PreparedMaskFrame {
  return {
    kind: PreparedMaskFrameKind.RgbaImage,
    key: `frame-${width}`,
    width,
    height: (width * 2) / 3,
    source: {} as HTMLCanvasElement,
    close() {},
    screenStrokes: [
      {
        detectionIndex: 0,
        width: strokeWidth,
        color: 0xff0000,
        alpha: 1,
        paths: [new Float32Array([10, 10, 20, 10, 20, 20, 10, 20])],
      },
    ],
  };
}

class FakeGraphics {
  visible = false;
  readonly clear = vi.fn();
  readonly moveTo = vi.fn();
  readonly lineTo = vi.fn();
  readonly closePath = vi.fn();
  readonly stroke = vi.fn(
    (_stroke: { width: number; alpha: number; color: number }) => this,
  );
  readonly destroy = vi.fn();
}
