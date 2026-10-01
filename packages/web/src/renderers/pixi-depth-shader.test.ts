import { afterEach, describe, expect, it, vi } from "vitest";

import {
  annotationRenderers,
  resolveDepthColorMapping,
  type DepthMap,
} from "supervision-js-core";
import {
  DEPTH_EDGE_RATIO,
  createPixiDepthShaderRenderer,
  resolveDepthShaderUniforms,
} from "#renderers/pixi-depth-shader";

type ShaderDescriptor = {
  readonly gl: { readonly fragment: string; readonly vertex: string };
  readonly gpu: {
    readonly fragment: { readonly entryPoint: string; readonly source: string };
    readonly vertex: { readonly entryPoint: string; readonly source: string };
  };
  readonly resources: Record<string, unknown>;
};

const disparityMap: DepthMap = {
  camera: { baselineM: 0.1, fxPx: 1000 },
  displayRange: { max: 100, min: 4 },
  height: 2,
  kind: "disparity_px",
  samples: { encoding: "scaled16", scale: 256, values: new Uint16Array(8) },
  width: 4,
};

afterEach(() => {
  vi.unstubAllGlobals();
  FakeShaderFactory.descriptors.length = 0;
});

function stubDocument(getContext = vi.fn()) {
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({ getContext, height: 0, width: 0 })),
  });
}

function createRenderer() {
  return createPixiDepthShaderRenderer({
    ImageSource: FakeImageSource as never,
    Mesh: FakeMesh as never,
    MeshGeometry: FakeMeshGeometry as never,
    Shader: FakeShaderFactory as never,
    UniformGroup: FakeUniformGroup as never,
    mediaHeight: 80,
    mediaWidth: 160,
  });
}

describe("pixi depth shader", () => {
  it("binds the depth texture, the colour table and its sampler", () => {
    stubDocument();
    const renderer = createRenderer();
    const depth = new FakeTextureSource();
    const lut = new FakeTextureSource();
    const mapping = resolveDepthColorMapping(disparityMap);

    renderer.render(
      depth as never,
      lut as never,
      resolveDepthShaderUniforms(
        disparityMap,
        mapping,
        annotationRenderers.depth(),
        {
          height: 80,
          width: 160,
        },
      ),
    );

    const resources = FakeShaderFactory.shaders[0]!.resources;

    expect(resources.uDepthTexture).toBe(depth);
    expect(resources.uLutTexture).toBe(lut);
    expect(resources.uLutSampler).toBe(lut.style);
    expect(renderer.mesh.visible).toBe(true);
  });

  it("writes the mapping core resolved into the uniforms", () => {
    stubDocument();
    const renderer = createRenderer();
    const mapping = resolveDepthColorMapping(disparityMap, {
      quantity: "depth",
    });

    renderer.render(
      new FakeTextureSource() as never,
      new FakeTextureSource() as never,
      resolveDepthShaderUniforms(
        disparityMap,
        mapping,
        annotationRenderers.depth({ noDepthColor: 0x336699, wipe: 0.25 }),
        { height: 80, width: 160 },
      ),
    );

    const uniforms = FakeUniformGroup.instances[0]!;

    expect(uniforms.uniforms).toMatchObject({
      uEdgeRatio: DEPTH_EDGE_RATIO,
      uEncoding: 0,
      uInnerOffset: 0,
      uInvScale: 1 / 256,
      uNearIsLow: 1,
      uNumerator: 100,
      uRangeHi: 25,
      uRangeLo: 1,
      uReciprocal: 1,
      uSampling: 1,
      uWipe: 0.25,
    });
    expect(Array.from(uniforms.uniforms.uMapSize as Float32Array)).toEqual([
      4, 2,
    ]);
    expect(Array.from(uniforms.uniforms.uNoDepthColor as Float32Array)).toEqual(
      [0.2, 0.4, 0.6, 1].map((value) => Math.fround(value)),
    );
    expect(uniforms.update).toHaveBeenCalledOnce();
  });

  it("samples the nearest pixel unless the map is smaller than the media", () => {
    const mapping = resolveDepthColorMapping(disparityMap);
    const depth = annotationRenderers.depth();

    expect(
      resolveDepthShaderUniforms(disparityMap, mapping, depth, {
        height: 2,
        width: 4,
      }).uSampling,
    ).toBe(0);
    expect(
      resolveDepthShaderUniforms(disparityMap, mapping, depth, {
        height: 4,
        width: 8,
      }).uSampling,
    ).toBe(1);
    expect(
      resolveDepthShaderUniforms(
        disparityMap,
        mapping,
        annotationRenderers.depth({ sampling: "nearest" }),
        { height: 4, width: 8 },
      ).uSampling,
    ).toBe(0);
  });

  it("describes preview codes and leaves no-depth pixels unpainted by default", () => {
    const preview: DepthMap = {
      ...disparityMap,
      samples: {
        encoding: "preview8",
        range: { max: 192, min: 0 },
        reservedMax: 15,
        values: new Uint8Array(8),
      },
    };
    const uniforms = resolveDepthShaderUniforms(
      preview,
      resolveDepthColorMapping(preview),
      annotationRenderers.depth(),
      { height: 2, width: 4 },
    );

    expect(uniforms).toMatchObject({
      uEncoding: 1,
      uPreviewHi: 192,
      uPreviewLo: 0,
      uPreviewTop: 255,
      uReservedMax: 15,
      uWipe: 1,
    });
    expect(Array.from(uniforms.uNoDepthColor)).toEqual([0, 0, 0, 0]);
  });

  it("tops TV-range preview codes at 235", () => {
    const preview: DepthMap = {
      ...disparityMap,
      samples: {
        encoding: "preview8",
        levels: "tv",
        range: { max: 192, min: 0 },
        reservedMax: 31,
        values: new Uint8Array(8),
      },
    };

    expect(
      resolveDepthShaderUniforms(
        preview,
        resolveDepthColorMapping(preview),
        annotationRenderers.depth(),
        { height: 2, width: 4 },
      ),
    ).toMatchObject({ uPreviewTop: 235, uReservedMax: 31 });
  });

  it("gives the placeholder texture canvas a rendering context", () => {
    const getContext = vi.fn();
    stubDocument(getContext);

    createRenderer();

    expect(getContext).toHaveBeenCalledWith("2d");
  });
});

class FakeTextureSource {
  readonly style = {};
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
  static readonly shaders: FakeShader[] = [];

  static from(options: ShaderDescriptor) {
    const shader = new FakeShader({ ...options.resources });

    FakeShaderFactory.descriptors.push(options);
    FakeShaderFactory.shaders.unshift(shader);

    return shader;
  }
}

class FakeUniformGroup {
  static readonly instances: FakeUniformGroup[] = [];
  readonly uniforms: Record<string, unknown> = {};

  constructor(uniforms: Record<string, { value: unknown }>) {
    for (const [key, { value }] of Object.entries(uniforms)) {
      this.uniforms[key] = value;
    }
    FakeUniformGroup.instances.unshift(this);
  }

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
