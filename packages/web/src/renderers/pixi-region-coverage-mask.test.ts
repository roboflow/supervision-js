import { describe, expect, it, vi } from "vitest";

import { createPixiRegionCoverageMask } from "./pixi-region-coverage-mask";

type MaskOptions = Parameters<typeof createPixiRegionCoverageMask>[0];
type ShaderProgram = Parameters<MaskOptions["Shader"]["from"]>[0];

describe("region coverage mask", () => {
  it("compiles for either renderer backend", () => {
    const program = buildProgram();

    expect(program?.gl.vertex).toContain("void main");
    expect(program?.gl.fragment).toContain("void main");
    expect(program?.gpu.vertex.source).toContain(
      `fn ${program?.gpu.vertex.entryPoint}`,
    );
    expect(program?.gpu.fragment.source).toContain(
      `fn ${program?.gpu.fragment.entryPoint}`,
    );
  });

  it("gives its placeholder canvas a rendering context", () => {
    const getContext = vi.fn();
    const createElement = vi.fn(() => ({ getContext }));

    vi.stubGlobal("document", { createElement });
    try {
      createPixiRegionCoverageMask(createMaskOptions(vi.fn(createShaderStub)));
    } finally {
      vi.unstubAllGlobals();
    }

    // WebGPU builds the placeholder into the shader's first bind group, and a
    // canvas that was never given a rendering context has nothing to bind.
    expect(getContext).toHaveBeenCalledWith("2d");
  });

  it("names the resources both programs read", () => {
    const program = buildProgram();

    // WGSL binds a resource by the name it is declared under, so a rename that
    // reaches only one program leaves WebGPU sampling an unbound texture.
    for (const resource of Object.keys(program?.resources ?? {})) {
      expect(program?.gpu.fragment.source).toContain(resource);
    }
  });
});

function buildProgram() {
  const shaderFrom = vi.fn<MaskOptions["Shader"]["from"]>(() =>
    createShaderStub(),
  );

  createPixiRegionCoverageMask(createMaskOptions(shaderFrom));

  return shaderFrom.mock.calls[0]?.[0] as ShaderProgram | undefined;
}

function createShaderStub() {
  return {
    destroy: vi.fn(),
    resources: {} as Record<string, unknown>,
  } as unknown as ReturnType<MaskOptions["Shader"]["from"]>;
}

function createMaskOptions(
  shaderFrom: MaskOptions["Shader"]["from"],
): MaskOptions {
  class Stub {
    destroy = vi.fn();
    position = { set: vi.fn() };
    rotation = 0;
    scale = { set: vi.fn() };
    style = {};
    uniforms: Record<string, unknown> = {};
    update = vi.fn();
  }

  return {
    AlphaMask: Stub,
    ImageSource: Stub,
    Mesh: Stub,
    MeshGeometry: Stub,
    Shader: { from: shaderFrom },
    UniformGroup: Stub,
  } as unknown as MaskOptions;
}
