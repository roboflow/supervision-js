import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_INTERACTION_STROKE_RADIUS,
  createPixiInteractionPresentationLayer,
} from "#renderers/pixi-interaction-presentation-layer";
import { BaseInteractionStyle } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import { DetectionPickTarget } from "supervision-js-core";

type ShaderDescriptor = {
  readonly gl: { readonly fragment: string; readonly vertex: string };
  readonly gpu: {
    readonly fragment: { readonly entryPoint: string; readonly source: string };
    readonly vertex: { readonly entryPoint: string; readonly source: string };
  };
  readonly resources: Record<string, unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeShaderFactory.descriptors.length = 0;
});

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      rect: { height: 30, width: 20, x: 20, y: 30 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

describe("pixi interaction presentation layer", () => {
  it("draws selected presentations when the active frame is an equivalent clone", () => {
    const selectedPick = {
      detection: frame.detections[0]!,
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: new BaseInteractionStyle(),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const graphics = display.children[0] as FakeGraphics;
    const clonedFrame = cloneDetectionFrame(frame);

    layer.drawFrame({
      frame: clonedFrame,
      hoveredPick: null,
      mediaTime: clonedFrame.mediaTime,
      selectedPick,
    });

    expect(graphics.rect).toHaveBeenCalledWith(10, 15, 20, 30);
    expect(graphics.stroke).toHaveBeenCalled();
  });

  it("declares a WebGL and a WebGPU program for the interaction mask shader", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ height: 0, width: 0 })),
    });

    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      Text: FakeText as never,
      UniformGroup: FakeUniformGroup as never,
    });

    layer.createDisplay({ height: 80, width: 120 });

    const descriptor = FakeShaderFactory.descriptors.at(-1)!;

    expect(descriptor.gl.vertex.length).toBeGreaterThan(0);
    expect(descriptor.gl.fragment.length).toBeGreaterThan(0);
    expect(descriptor.gpu.vertex.entryPoint).toBe("mainVertex");
    expect(descriptor.gpu.fragment.entryPoint).toBe("mainFragment");
    expect(descriptor.gpu.vertex.source).toContain("fn mainVertex(");
    expect(descriptor.gpu.fragment.source).toContain("fn mainFragment(");
  });

  it("bounds the stroke scan by the stroke width in use, not by the compile-time maximum", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ height: 0, width: 0 })),
    });

    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      Text: FakeText as never,
      UniformGroup: FakeUniformGroup as never,
    });

    layer.createDisplay({ height: 80, width: 120 });

    const descriptor = FakeShaderFactory.descriptors.at(-1)!;

    expect(descriptor.gl.fragment).toContain(
      `int radius = int(min(uMaxStrokeWidth, float(${MAX_INTERACTION_STROKE_RADIUS})));`,
    );
    expect(descriptor.gpu.fragment.source).toContain(
      `let radius = i32(min(interactionMaskUniforms.uMaxStrokeWidth, ${MAX_INTERACTION_STROKE_RADIUS}.0));`,
    );

    for (const source of [
      descriptor.gl.fragment,
      descriptor.gpu.fragment.source,
    ]) {
      expect(source).toContain("offsetY = radius; offsetY >= -radius");
      expect(source).toContain("offsetX = radius; offsetX >= -radius");
      expect(source).not.toContain(
        `offsetY = -${MAX_INTERACTION_STROKE_RADIUS}`,
      );
      expect(source).not.toContain(
        `offsetX = -${MAX_INTERACTION_STROKE_RADIUS}`,
      );
    }
  });
});

class FakeContainer {
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeGraphics {
  readonly clear = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly rect = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  readonly stroke = vi.fn(() => this);
}

class FakeImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

class FakeMeshGeometry {
  constructor(readonly _options: unknown) {}

  readonly destroy = vi.fn();
}

class FakeShader {
  constructor(readonly resources: Record<string, unknown>) {}

  readonly destroy = vi.fn();
}

class FakeShaderFactory {
  static readonly descriptors: ShaderDescriptor[] = [];

  static from(options: ShaderDescriptor) {
    FakeShaderFactory.descriptors.push(options);

    return new FakeShader(options.resources);
  }
}

class FakeUniformGroup {
  constructor(readonly uniforms: Record<string, unknown>) {}

  readonly update = vi.fn();
}

class FakeMesh {
  alpha = 1;
  visible = true;

  constructor(
    readonly options: {
      readonly geometry: FakeMeshGeometry;
      readonly shader: FakeShader;
    },
  ) {}

  get shader() {
    return this.options.shader;
  }

  set shader(_shader: FakeShader) {}

  readonly destroy = vi.fn();
}

class FakeText {
  alpha = 1;
  height = 10;
  style: unknown;
  text = "";
  visible = true;
  width = 20;
  x = 0;
  y = 0;

  constructor(options: { readonly style?: unknown; readonly text?: string }) {
    this.style = options.style;
    this.text = options.text ?? "";
  }
}

function cloneDetectionFrame(sourceFrame: DetectionFrame): DetectionFrame {
  return {
    ...sourceFrame,
    detections: sourceFrame.detections.map((detection) => ({ ...detection })),
  };
}
