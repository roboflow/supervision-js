import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_ID_MASK_STROKE_WIDTH } from "#render-preparation/mask-frame-compositor";
import { createPixiIdMaskShaderRenderer } from "#renderers/pixi-id-mask-shader";

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

describe("pixi ID-mask shader", () => {
  it("declares a WebGL and a WebGPU program for the same shader", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    createPixiIdMaskShaderRenderer({
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
      mediaHeight: 80,
      mediaWidth: 120,
    });

    const descriptor = FakeShaderFactory.descriptors[0]!;

    expect(descriptor.gl.vertex.length).toBeGreaterThan(0);
    expect(descriptor.gl.fragment.length).toBeGreaterThan(0);
    expect(descriptor.gpu.vertex.entryPoint).toBe("mainVertex");
    expect(descriptor.gpu.fragment.entryPoint).toBe("mainFragment");
    expect(descriptor.gpu.vertex.source).toContain("fn mainVertex(");
    expect(descriptor.gpu.fragment.source).toContain("fn mainFragment(");
  });

  it("gives the placeholder texture canvas a rendering context", () => {
    const getContext = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ getContext, height: 0, width: 0 })),
    });

    createPixiIdMaskShaderRenderer({
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
      mediaHeight: 80,
      mediaWidth: 120,
    });

    expect(getContext).toHaveBeenCalledWith("2d");
  });

  it("bounds the border scan by the stroke width in use, not by the compile-time maximum", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: vi.fn(),
        height: 0,
        width: 0,
      })),
    });

    createPixiIdMaskShaderRenderer({
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: FakeShaderFactory as never,
      UniformGroup: FakeUniformGroup as never,
      mediaHeight: 80,
      mediaWidth: 120,
    });

    const descriptor = FakeShaderFactory.descriptors[0]!;

    expect(descriptor.gl.fragment).toContain(
      `int radius = int(min(uMaxStrokeWidth, float(${MAX_ID_MASK_STROKE_WIDTH})));`,
    );
    expect(descriptor.gpu.fragment.source).toContain(
      `let radius = i32(min(maskUniforms.uMaxStrokeWidth, ${MAX_ID_MASK_STROKE_WIDTH}.0));`,
    );

    for (const source of [
      descriptor.gl.fragment,
      descriptor.gpu.fragment.source,
    ]) {
      expect(source).toContain("offsetY = radius; offsetY >= -radius");
      expect(source).toContain("offsetX = radius; offsetX >= -radius");
      expect(source).not.toContain(`offsetY = -${MAX_ID_MASK_STROKE_WIDTH}`);
      expect(source).not.toContain(`offsetX = -${MAX_ID_MASK_STROKE_WIDTH}`);
    }
  });
});

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
