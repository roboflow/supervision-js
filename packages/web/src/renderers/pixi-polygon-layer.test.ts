import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BasePolygonStyle, BoxStrokeAlignment } from "supervision-js-core";
import type { DetectionFrame, PolygonStyle } from "supervision-js-core";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import { createPreparedRenderWindow } from "#render-preparation/prepared-render-window";

const preparedWindow = vi.hoisted(() => ({
  frame: undefined as
    | {
        detectionFrame: DetectionFrame;
        key: string;
        maskFrame?: unknown;
        maskStatus: string;
      }
    | undefined,
}));

vi.mock("#render-preparation/prepared-render-window", () => ({
  PreparedRenderFrameMaskStatus: {
    Disabled: "disabled",
    Empty: "empty",
    Pending: "pending",
    Prepared: "prepared",
  },
  createPreparedRenderWindow: vi.fn(() => ({
    destroy: vi.fn(),
    getFrame: vi.fn(() => preparedWindow.frame),
    invalidateMaskDisplayWidth: vi.fn(),
    invalidateRasterSize: vi.fn(),
    isArtifactPrepared: vi.fn(
      () => preparedWindow.frame?.maskStatus === "prepared",
    ),
    setMaskStyle: vi.fn(),
    setPlaybackActive: vi.fn(),
    setTimelineContext: vi.fn(),
    waitForReady: vi.fn(() => Promise.resolve()),
  })),
}));

import {
  canPreparePolygonInstruction,
  createPixiPolygonLayer,
  resolvePreparedPolygonInstructions,
} from "./pixi-polygon-layer";

beforeEach(() => {
  preparedWindow.frame = undefined;
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => ({}), height: 0, width: 0 }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(
      canPreparePolygonInstruction({
        points,
        stroke: {
          alpha: 1,
          cap: "round",
          color: 0xffffff,
          join: "bevel",
          miterLimit: 7,
          width: 3,
        },
      }),
    ).toBe(false);
  });

  it("resolves ordered polygon strokes in CSS pixels across fit and zoom", () => {
    const frame = {
      detections: [
        { id: "front", polygon: { points }, zIndex: 2 },
        { id: "back", polygon: { points }, zIndex: 1 },
      ],
      frameIndex: 4,
      mediaTime: 2,
    };
    const options = {
      frame,
      mediaHeight: 50,
      mediaTime: 2,
      mediaWidth: 100,
      polygonStyle: new BasePolygonStyle({
        fill: { alpha: 0.2, color: 0xff0000 },
        stroke: { alpha: 1, color: 0xffffff, width: 6 },
      }),
      viewportScale: 0.5,
    };
    const instructions = resolvePreparedPolygonInstructions(options);

    expect(instructions.map(({ detectionIndex }) => detectionIndex)).toEqual([
      1, 0,
    ]);
    expect(instructions[0]).toMatchObject({
      alpha: 0.2,
      color: 0xff0000,
      polygon: { height: 50, points, width: 100 },
      stroke: {
        alignment: BoxStrokeAlignment.Center,
        alpha: 1,
        color: 0xffffff,
        width: 6,
      },
    });
    expect(
      resolvePreparedPolygonInstructions({ ...options, viewportScale: 2 })[0]
        ?.stroke,
    ).toEqual(instructions[0]?.stroke);
  });

  it("forwards paused and playing states to polygon preparation", () => {
    const layer = createLayer();
    const window = vi
      .mocked(createPreparedRenderWindow)
      .mock.results.at(-1)!.value;

    layer.setPlaybackActive(false);
    layer.createDisplay({ height: 50, width: 100 });
    layer.setPlaybackActive(true);

    expect(window.setPlaybackActive.mock.calls).toEqual([[false], [true]]);
  });

  it("applies display density and viewport styles to the prepared polygon mesh", () => {
    const layer = createLayer({
      resolve: (_detection, { viewportScale = 1 }) => ({
        fill: { alpha: 0.2, color: viewportScale > 1 ? 0xff0000 : 0xffffff },
        points,
      }),
    });
    const display = layer.createDisplay({ height: 50, width: 100 });
    const mesh = (display as unknown as FakeContainer).children[1] as FakeMesh;
    const uniforms = (mesh.shader as FakeShader).resources
      .maskUniforms as FakeUniformGroup;
    const window = vi
      .mocked(createPreparedRenderWindow)
      .mock.results.at(-1)!.value;
    const options = vi.mocked(createPreparedRenderWindow).mock.calls.at(-1)![0];
    const rasterDisplay = {
      boxHeight: 25,
      boxWidth: 50,
      devicePixelRatio: 2,
      maxDevicePixelRatio: 2,
    };

    preparedWindow.frame = {
      detectionFrame: {
        detections: [{ polygon: { points } }],
        frameIndex: 3,
        mediaTime: 0.1,
      },
      key: "polygon-frame",
      maskStatus: "pending",
    };
    const resolveInstructions = () =>
      options.resolveInstructions?.({
        frame: preparedWindow.frame!.detectionFrame,
        maskStyle: options.maskStyle!,
        mediaTime: 0.1,
      });
    layer.setRasterDisplay(rasterDisplay, 2);
    layer.setViewportScale(0.5);
    layer.drawFrame(0.1, 0.5);
    const fitStyleKey = window.setMaskStyle.mock.calls.at(-1)?.[0]?.artifactKey;

    expect(mesh.visible).toBe(false);
    expect(options.resolveMaskDisplayWidth?.()).toBe(50);
    expect(resolveInstructions()?.[0]?.color).toBe(0xffffff);

    preparedWindow.frame = {
      ...preparedWindow.frame,
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1, 0.5);

    expect(mesh.visible).toBe(true);
    expect(uniforms.uniforms.uStrokePixelRatio).toBe(4);
    layer.setViewportScale(2);
    expect(options.resolveMaskDisplayWidth?.()).toBe(200);
    expect(resolveInstructions()?.[0]?.color).toBe(0xff0000);
    expect(window.setMaskStyle.mock.calls.at(-1)?.[0]?.artifactKey).not.toBe(
      fitStyleKey,
    );
    layer.setRasterDisplay(rasterDisplay, 0.25);
    expect(uniforms.uniforms.uStrokePixelRatio).toBe(0.5);
  });

  it("takes a drawn polygon frame off the screen when asked to clear", () => {
    const layer = createLayer();
    const display = layer.createDisplay({ height: 50, width: 100 });
    const mesh = (display as unknown as FakeContainer).children[1] as FakeMesh;

    preparedWindow.frame = {
      detectionFrame: { detections: [], frameIndex: 3, mediaTime: 0.1 },
      key: "polygon-frame",
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    expect(mesh.visible).toBe(true);

    layer.clearFrame();

    expect(mesh.visible).toBe(false);
  });
});

function createLayer(
  polygonStyle: PolygonStyle = new BasePolygonStyle({
    fill: { alpha: 0.2, color: 0xff0000 },
    stroke: { alpha: 1, color: 0xffffff, width: 2 },
  }),
) {
  return createPixiPolygonLayer({
    BufferImageSource: FakeBufferImageSource as never,
    Container: FakeContainer as never,
    ImageSource: FakeImageSource as never,
    Mesh: FakeMesh as never,
    MeshGeometry: FakeMeshGeometry as never,
    Shader: FakeShader as never,
    Sprite: FakeSprite as never,
    Texture: FakeTexture as never,
    UniformGroup: FakeUniformGroup as never,
    detectionTimeline: {} as never,
    polygonStyle,
  });
}

function idMaskFrame() {
  return {
    close: vi.fn(),
    fillPalette: new Float32Array(),
    hasStroke: true,
    height: 50,
    key: "polygon-frame",
    kind: PreparedMaskFrameKind.IdMask,
    maxStrokeWidth: 2,
    raster: new Uint8Array(100 * 50),
    strokePalette: new Float32Array(),
    strokeWidths: new Float32Array(),
    width: 100,
  };
}

class FakeImageSource {
  readonly style = {};
  destroy = vi.fn();

  constructor(readonly _options: unknown) {}
}

class FakeBufferImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}
}

class FakeTexture {
  static readonly EMPTY = new FakeTexture({});
  readonly source = {};

  constructor(readonly _options: unknown) {}
}

class FakeSprite {
  alpha = 1;
  height = 0;
  texture: unknown;
  visible = true;
  width = 0;
}

class FakeContainer {
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeMesh {
  alpha = 1;
  shader: unknown;
  visible = false;
  destroy = vi.fn();

  constructor(options: { shader: unknown }) {
    this.shader = options.shader;
  }
}

class FakeMeshGeometry {
  destroy = vi.fn();

  constructor(readonly _options: unknown) {}
}

class FakeShader {
  static from = vi.fn(
    ({ resources }: { resources: Record<string, unknown> }) =>
      new FakeShader(resources),
  );

  constructor(readonly resources: Record<string, unknown>) {}

  destroy = vi.fn();
}

class FakeUniformGroup {
  readonly uniforms: Record<string, unknown> = {};
  update = vi.fn();

  constructor(uniforms: Record<string, { value: unknown }>) {
    for (const [name, uniform] of Object.entries(uniforms)) {
      this.uniforms[name] = uniform.value;
    }
  }
}
