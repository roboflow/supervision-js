import { describe, expect, it, vi } from "vitest";

import { AnnotationGestureStateKind } from "supervision-js-core";

import { createPixiAnnotationOverlayLayer } from "./pixi-annotation-overlay-layer";

function createGraphicsMock() {
  const graphics = {
    circle: vi.fn(),
    clear: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    poly: vi.fn(),
    roundRect: vi.fn(),
    stroke: vi.fn(),
  };
  for (const method of [
    graphics.circle,
    graphics.fill,
    graphics.poly,
    graphics.roundRect,
    graphics.stroke,
  ]) {
    method.mockReturnValue(graphics);
  }
  return graphics;
}

describe("Pixi annotation overlay presentation", () => {
  it("fills box creation previews with the configured class treatment", () => {
    const graphics = createGraphicsMock();
    const preview = {
      id: "draft-box",
      rect: { height: 20, width: 30, x: 40, y: 50 },
    };
    const engine = {
      getState: () => ({
        activeDetectionId: null,
        activeHandleId: null,
        kind: AnnotationGestureStateKind.Creating,
        pointerId: 1,
        preview,
      }),
      hasCreationTool: () => true,
    };
    const layer = createPixiAnnotationOverlayLayer(engine as never, {
      editingPreview: {
        boxFill: { alpha: 0.08, color: 0xff0056 },
        stroke: { alpha: 1, color: 0xff0056, width: 2 },
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
      selectedDetectionIds: [],
      viewportScale: 2,
    });

    expect(graphics.roundRect).toHaveBeenCalledWith(25, 40, 30, 20, 0.5);
    expect(graphics.fill).toHaveBeenCalledWith({
      alpha: 0.08,
      color: 0xff0056,
    });
    expect(graphics.stroke).toHaveBeenCalledWith({
      alpha: 1,
      color: 0xff0056,
      width: 1,
    });
  });

  it("renders polygon creation as an open path without ancillary bounds", () => {
    const graphics = createGraphicsMock();
    const preview = {
      id: "draft-polygon",
      polygon: {
        points: [
          { x: 10, y: 10 },
          { x: 40, y: 10 },
          { x: 40, y: 40 },
          { x: 60, y: 60 },
        ],
      },
      rect: { height: 50, width: 50, x: 35, y: 35 },
    };
    const engine = {
      getState: () => ({
        activeDetectionId: null,
        activeHandleId: null,
        kind: AnnotationGestureStateKind.Creating,
        pointerId: 1,
        preview,
      }),
      hasCreationTool: () => true,
    };
    const layer = createPixiAnnotationOverlayLayer(engine as never, {
      editingPreview: {
        closeZoneStroke: { alpha: 1, color: 0x22c55e, width: 2 },
        stroke: { alpha: 1, color: 0xff0056, width: 2 },
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
      selectedDetectionIds: [],
      viewportScale: 1,
    });

    expect(graphics.roundRect).not.toHaveBeenCalled();
    expect(graphics.poly).not.toHaveBeenCalled();
    expect(graphics.circle).toHaveBeenCalledTimes(4);
    expect(graphics.fill).toHaveBeenCalledTimes(3);
    expect(graphics.fill).toHaveBeenCalledWith({
      alpha: 1,
      color: 0xff80ab,
    });
    expect(graphics.moveTo.mock.calls.length).toBeGreaterThan(4);
  });

  it("highlights the first polygon vertex when the cursor can close it", () => {
    const graphics = createGraphicsMock();
    const preview = {
      id: "draft-polygon",
      polygon: {
        points: [
          { x: 10, y: 10 },
          { x: 40, y: 10 },
          { x: 40, y: 40 },
          { x: 12, y: 12 },
        ],
      },
      rect: { height: 30, width: 30, x: 25, y: 25 },
    };
    const engine = {
      getState: () => ({
        activeDetectionId: null,
        activeHandleId: null,
        kind: AnnotationGestureStateKind.Creating,
        pointerId: 1,
        preview,
      }),
      hasCreationTool: () => true,
    };
    const layer = createPixiAnnotationOverlayLayer(engine as never, {
      editingPreview: {
        closeZoneStroke: { alpha: 1, color: 0x22c55e, width: 2 },
        stroke: { alpha: 1, color: 0xff0056, width: 2 },
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
      selectedDetectionIds: [],
      viewportScale: 1,
    });

    expect(graphics.fill).toHaveBeenCalledWith({
      alpha: 0.2,
      color: 0x22c55e,
    });
    expect(graphics.fill).toHaveBeenCalledWith({
      alpha: 1,
      color: 0x22c55e,
    });
  });

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
