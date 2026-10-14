import { describe, expect, it, vi } from "vitest";
import { StrokeAlignment } from "supervision-js-core";
import { buildLine } from "pixi.js";
import {
  PreparedMaskFrameKind,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import { createPixiMaskScreenStrokeRenderer } from "#renderers/pixi-mask-screen-stroke";

describe("screen-space mask strokes", () => {
  it.each([
    { alignment: StrokeAlignment.Outside, outer: [-0.25, 3.25], hole: [1, 2] },
    {
      alignment: StrokeAlignment.Center,
      outer: [-0.125, 3.125],
      hole: [0.875, 2.125],
    },
    { alignment: StrokeAlignment.Inside, outer: [0, 3], hole: [0.75, 2.25] },
  ])(
    "keeps $alignment contours on the correct side of holes in real Pixi geometry",
    ({ alignment, outer, hole }) => {
      const renderer = createPixiMaskScreenStrokeRenderer({
        Graphics: FakeGraphics as never,
        mediaWidth: 3,
        mediaHeight: 3,
      });
      const graphics = renderer.display as unknown as FakeGraphics;
      const pending: number[][] = [];
      const meshes: number[][] = [];
      graphics.moveTo.mockImplementation((x: number, y: number) => {
        pending.push([x, y]);
      });
      graphics.lineTo.mockImplementation((x: number, y: number) => {
        pending[pending.length - 1]!.push(x, y);
      });
      graphics.stroke.mockImplementation((paint) => {
        for (const path of pending) {
          const vertices: number[] = [];
          buildLine(
            path,
            {
              cap: "butt",
              join: "round",
              miterLimit: 10,
              ...paint,
            } as Parameters<typeof buildLine>[1],
            false,
            true,
            vertices,
            [],
          );
          meshes.push(vertices);
        }
        pending.length = 0;
        return graphics;
      });
      const frame = outlineFrame(3, 0.25);
      const ring = {
        ...frame,
        height: 3,
        screenStrokes: [
          {
            ...frame.screenStrokes![0]!,
            alignment,
            paths: [
              new Float32Array([0, 0, 3, 0, 3, 3, 0, 3]),
              new Float32Array([1, 1, 1, 2, 2, 2, 2, 1]),
            ],
          },
        ],
      };
      renderer.render(ring, 1);
      expect(meshes).toHaveLength(2);
      for (const [index, expected] of [outer, hole].entries()) {
        const coordinates = meshes[index]!;
        expect(Math.min(...coordinates)).toBeCloseTo(expected[0]!, 8);
        expect(Math.max(...coordinates)).toBeCloseTo(expected[1]!, 8);
      }
      expect(graphics.stroke).toHaveBeenCalledTimes(
        alignment === StrokeAlignment.Center ? 1 : 2,
      );
      renderer.destroy();
    },
  );

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

  it.each(["mask", "screen"] as const)(
    "keeps %s units and alignment through raster reduction and zoom",
    (widthUnit) => {
      const renderer = createPixiMaskScreenStrokeRenderer({
        Graphics: FakeGraphics as never,
        mediaWidth: 120,
        mediaHeight: 80,
      });
      const graphics = renderer.display as unknown as FakeGraphics;
      for (const rasterWidth of [12, 60]) {
        const frame = {
          ...outlineFrame(rasterWidth, 2),
          kind: PreparedMaskFrameKind.IdMask as const,
          sourceWidth: 60,
          raster: new Uint8Array((rasterWidth * rasterWidth * 2) / 3),
          fillPalette: new Float32Array(8),
          strokePalette: new Float32Array(8),
          strokeWidths: new Float32Array(2),
          maxStrokeWidth: 0,
          hasStroke: false,
        };
        for (const scale of [0.25, 1, 4]) {
          for (const alignment of [
            StrokeAlignment.Outside,
            StrokeAlignment.Center,
            StrokeAlignment.Inside,
          ]) {
            renderer.render(frame, scale, [
              {
                detectionIndex: 0,
                stroke: {
                  alpha: 1,
                  color: 0xff0000,
                  width: 2,
                  widthUnit,
                  alignment,
                },
              },
            ]);
            const stroke = graphics.stroke.mock.lastCall![0];
            expect(stroke.width * scale).toBeCloseTo(
              widthUnit === "mask" ? 8 * scale : 2,
            );
            expect(stroke).toMatchObject({
              alignment:
                alignment === StrokeAlignment.Outside
                  ? 0
                  : alignment === StrokeAlignment.Center
                    ? 0.5
                    : 1,
            });
          }
        }
      }
      renderer.destroy();
    },
  );
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
