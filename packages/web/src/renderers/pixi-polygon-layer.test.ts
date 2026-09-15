import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BasePolygonStyle, BoxStrokeAlignment } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";

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
  it("puts a prepared polygon frame on the screen through the id-mask mesh", () => {
    const layer = createLayer();
    const display = layer.createDisplay({ height: 50, width: 100 });
    const mesh = (display as unknown as FakeContainer).children[1] as FakeMesh;

    preparedWindow.frame = {
      detectionFrame: { detections: [], frameIndex: 3, mediaTime: 0.1 },
      key: "polygon-frame",
      maskStatus: "pending",
    };
    layer.drawFrame(0.1);

    expect(mesh.visible).toBe(false);

    preparedWindow.frame = {
      ...preparedWindow.frame,
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    expect(mesh.visible).toBe(true);
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

function createLayer() {
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
    polygonStyle: new BasePolygonStyle({
      fill: { alpha: 0.2, color: 0xff0000 },
      stroke: { alpha: 1, color: 0xffffff, width: 2 },
    }),
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
  static from = vi.fn(() => new FakeShader());
  readonly resources: Record<string, unknown> = {};
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
