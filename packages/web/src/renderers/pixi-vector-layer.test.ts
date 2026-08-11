import { describe, expect, it, vi } from "vitest";

import { createPixiVectorLayer } from "#renderers/pixi-vector-layer";
import {
  KeypointMarkerShape,
  MarkerShape,
  MarkerSizeSpace,
  ShapeInstructionKind,
  StrokeAlignment,
} from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionFrame,
  KeypointStyle,
  ShapeStyle,
} from "supervision-js-core";

describe("pixi vector layer", () => {
  it("recycles graphics when frame-scoped detection ids change", () => {
    const frames = [
      createFrame(0, ["pose-0", "pose-1"]),
      createFrame(1, ["pose-2"]),
    ];
    const layer = createLayer(frames);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    expect(container.children).toHaveLength(2);

    layer.drawFrame(1);
    expect(container.children).toHaveLength(2);
    expect(container.children.filter((child) => child.visible)).toHaveLength(1);
    expect(layer.translateDetection("pose-0", 1, 2)).toBe(false);
    expect(layer.translateDetection("pose-2", 3, 4)).toBe(true);
  });

  it("does not allocate graphics when the matching style is disabled", () => {
    const frame = createFrame(0, ["pose-0"]);
    const layer = createLayer([frame], null);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(container.children).toHaveLength(0);
  });

  it("releases active graphics when the matching style is disabled", () => {
    const frame = createFrame(0, ["pose-0"]);
    const layer = createLayer([frame]);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    layer.setStyles({ keypointStyle: null });
    layer.drawFrame(0);

    expect(container.children).toHaveLength(1);
    expect(container.children[0]?.visible).toBe(false);
    expect(layer.translateDetection("pose-0", 1, 2)).toBe(false);
  });

  it("does not allocate graphics when styles resolve no instructions", () => {
    const frame = createFrame(0, ["pose-0"]);
    const layer = createLayer([frame], { resolve: () => undefined });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(container.children).toHaveLength(0);
  });

  it("redraws an invalidated active detection without allocating", () => {
    const frame = createFrame(0, ["pose-0"]);
    const layer = createLayer([frame]);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    const display = container.children[0]!;
    expect(display.clear).toHaveBeenCalledOnce();

    layer.drawFrame(0);
    expect(display.clear).toHaveBeenCalledOnce();

    layer.invalidateDetection("pose-0");
    layer.drawFrame(0);
    expect(container.children).toHaveLength(1);
    expect(display.clear).toHaveBeenCalledTimes(2);
    expect(display.position.set).toHaveBeenLastCalledWith(0, 0);
  });

  it("renders shape decorations for detections without semantic vector geometry", () => {
    const boxOnlyFrame: DetectionFrame = {
      detections: [
        { id: "box-0", rect: { height: 40, width: 20, x: 30, y: 40 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const shapeStyle: ShapeStyle = {
      resolve(detection) {
        if (!detection.rect) return undefined;

        return [
          {
            center: { x: detection.rect.x, y: detection.rect.y },
            kind: ShapeInstructionKind.Ellipse,
            radiusX: detection.rect.width / 2,
            radiusY: 4,
            stroke: { alpha: 1, color: 0xffffff, width: 2 },
          },
        ];
      },
    };
    const layer = createPixiVectorLayer({
      Container: FakeContainer as never,
      detectionTimeline: createTimeline([boxOnlyFrame]),
      Graphics: FakeGraphics as never,
      keypointStyle: null,
      polygonStyle: null,
      polylineStyle: null,
      shapeStyle,
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(container.children).toHaveLength(1);
    const display = container.children[0]!;
    expect(display.moveTo).toHaveBeenCalled();
    expect(display.stroke).toHaveBeenCalled();
    expect(display.fill).not.toHaveBeenCalled();
  });

  it("keeps skipping geometry-free detections when no shape style is set", () => {
    const boxOnlyFrame: DetectionFrame = {
      detections: [
        { id: "box-0", rect: { height: 40, width: 20, x: 30, y: 40 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const layer = createLayer([boxOnlyFrame]);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    expect(container.children).toHaveLength(0);
  });

  it("draws filled closed markers and screen-scaled circle markers", () => {
    const boxOnlyFrame: DetectionFrame = {
      detections: [
        { id: "box-0", rect: { height: 40, width: 20, x: 30, y: 40 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const shapeStyle: ShapeStyle = {
      resolve: () => [
        {
          fill: { alpha: 1, color: 0xff0000 },
          kind: ShapeInstructionKind.Marker,
          point: { x: 30, y: 20 },
          shape: MarkerShape.Triangle,
          size: 12,
          sizeSpace: MarkerSizeSpace.Screen,
        },
        {
          fill: { alpha: 1, color: 0x00ff00 },
          kind: ShapeInstructionKind.Marker,
          point: { x: 30, y: 40 },
          shape: MarkerShape.Circle,
          size: 10,
          sizeSpace: MarkerSizeSpace.Screen,
          stroke: {
            alignment: StrokeAlignment.Outside,
            alpha: 1,
            color: 0xffffff,
            width: 2,
          },
        },
      ],
    };
    const layer = createPixiVectorLayer({
      Container: FakeContainer as never,
      detectionTimeline: createTimeline([boxOnlyFrame]),
      Graphics: FakeGraphics as never,
      keypointStyle: null,
      polygonStyle: null,
      polylineStyle: null,
      shapeStyle,
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0, 2);

    const display = container.children[0]!;
    // Triangle: closed filled polygon inscribed in a 12px/scale-2 circle.
    expect(display.poly).toHaveBeenCalledTimes(1);
    const polyCalls = display.poly.mock.calls as unknown as [
      number[],
      boolean,
    ][];
    const trianglePoints = polyCalls[0]![0];
    expect(trianglePoints).toHaveLength(6);
    expect(trianglePoints[0]).toBeCloseTo(30);
    expect(trianglePoints[1]).toBeCloseTo(23);
    // Circle: native circle with the screen size divided by the scale.
    expect(display.circle).toHaveBeenCalledWith(30, 40, 2.5);
    expect(display.stroke).toHaveBeenCalledWith({
      alignment: 0,
      alpha: 1,
      color: 0xffffff,
      width: 1,
    });
  });

  it("draws dashed circle marker strokes through the shared path lowering", () => {
    const boxOnlyFrame: DetectionFrame = {
      detections: [
        { id: "box-0", rect: { height: 40, width: 20, x: 30, y: 40 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const shapeStyle: ShapeStyle = {
      resolve: () => [
        {
          kind: ShapeInstructionKind.Marker,
          point: { x: 30, y: 40 },
          shape: MarkerShape.Circle,
          size: 10,
          sizeSpace: MarkerSizeSpace.Media,
          stroke: {
            alpha: 1,
            color: 0xffffff,
            dash: [4, 2],
            width: 2,
          },
        },
      ],
    };
    const layer = createPixiVectorLayer({
      Container: FakeContainer as never,
      detectionTimeline: createTimeline([boxOnlyFrame]),
      Graphics: FakeGraphics as never,
      keypointStyle: null,
      polygonStyle: null,
      polylineStyle: null,
      shapeStyle,
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    const display = container.children[0]!;
    expect(display.circle).not.toHaveBeenCalled();
    expect(display.moveTo).toHaveBeenCalled();
    expect(display.lineTo).toHaveBeenCalled();
    expect(display.stroke).toHaveBeenCalledWith({
      alpha: 1,
      color: 0xffffff,
      width: 2,
    });
  });

  it("draws every subpath of a path instruction", () => {
    const boxOnlyFrame: DetectionFrame = {
      detections: [
        { id: "box-0", rect: { height: 40, width: 20, x: 30, y: 40 } },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const shapeStyle: ShapeStyle = {
      resolve: () => [
        {
          closed: false,
          kind: ShapeInstructionKind.Path,
          segments: [
            [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
            ],
            [
              { x: 0, y: 10 },
              { x: 5, y: 10 },
            ],
          ],
          stroke: { alpha: 1, color: 0xffffff, width: 2 },
        },
      ],
    };
    const layer = createPixiVectorLayer({
      Container: FakeContainer as never,
      detectionTimeline: createTimeline([boxOnlyFrame]),
      Graphics: FakeGraphics as never,
      keypointStyle: null,
      polygonStyle: null,
      polylineStyle: null,
      shapeStyle,
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);

    const display = container.children[0]!;
    expect(display.moveTo).toHaveBeenCalledTimes(2);
    expect(display.moveTo).toHaveBeenNthCalledWith(1, 0, 0);
    expect(display.moveTo).toHaveBeenNthCalledWith(2, 0, 10);
    expect(display.stroke).toHaveBeenCalledTimes(2);
  });

  it("redraws a replacement frame at the same timeline position", () => {
    const frames = [createFrame(0, ["pose-0"])];
    const layer = createLayer(frames);
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    const display = container.children[0]!;
    expect(display.circle).toHaveBeenLastCalledWith(1, 2, 3);

    frames[0] = {
      ...frames[0]!,
      detections: [
        {
          ...frames[0]!.detections[0]!,
          keypoints: { edges: [], points: [{ x: 11, y: 12 }] },
        },
      ],
    };
    layer.drawFrame(0);

    expect(display.clear).toHaveBeenCalledTimes(2);
    expect(display.circle).toHaveBeenLastCalledWith(11, 12, 3);
  });
});

class FakeContainer {
  readonly children: FakeGraphics[] = [];
  sortableChildren = false;

  addChild(...children: FakeGraphics[]) {
    this.children.push(...children);
  }
}

class FakeGraphics {
  readonly circle = vi.fn(() => this);
  readonly clear = vi.fn(() => this);
  readonly closePath = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly lineTo = vi.fn(() => this);
  readonly moveTo = vi.fn(() => this);
  readonly poly = vi.fn(() => this);
  readonly position = { set: vi.fn() };
  readonly stroke = vi.fn(() => this);
  visible = true;
  zIndex = 0;
}

const keypointStyle: KeypointStyle = {
  resolve(detection) {
    if (!detection.keypoints) return undefined;

    return {
      edges: [],
      markers: detection.keypoints.points.map((point, index) => ({
        fill: { alpha: 1, color: 0xff0000 },
        index,
        point,
        radius: 3,
        shape: KeypointMarkerShape.Circle,
      })),
    };
  },
};

function createLayer(
  frames: readonly DetectionFrame[],
  style: KeypointStyle | null = keypointStyle,
) {
  return createPixiVectorLayer({
    Container: FakeContainer as never,
    detectionTimeline: createTimeline(frames),
    Graphics: FakeGraphics as never,
    keypointStyle: style,
    polygonStyle: null,
    polylineStyle: null,
  });
}

function createFrame(
  frameIndex: number,
  ids: readonly string[],
): DetectionFrame {
  return {
    detections: ids.map((id, index) => ({
      id,
      keypoints: {
        edges: [],
        points: [{ x: index + 1, y: index + 2 }],
      },
    })),
    frameIndex,
    mediaTime: frameIndex,
  };
}

function createTimeline(
  frames: readonly DetectionFrame[],
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames: () => frames,
    getState: () => ({
      bufferEndTime: frames.at(-1)?.mediaTime ?? 0,
      bufferStartTime: frames[0]?.mediaTime ?? 0,
      detectionCount: frames.reduce(
        (count, frame) => count + frame.detections.length,
        0,
      ),
      errorMessage: null,
      frameCount: frames.length,
      requestedEndTime: frames.at(-1)?.mediaTime ?? 0,
      requestedStartTime: frames[0]?.mediaTime ?? 0,
      status: "ready",
    }),
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: (mediaTime: number) =>
      frames.find((frame) => frame.mediaTime === mediaTime),
  } as unknown as BufferedDetectionTimeline;
}
