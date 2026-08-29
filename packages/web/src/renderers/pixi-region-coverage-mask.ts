import { untintedMaskVertexWgsl } from "#renderers/mask-vertex";
import {
  createShaderPlaceholderCanvas,
  destroyShaderKeepingProgram,
} from "#renderers/pixi-shader-lifecycle";
import type { PreparedRegionMaskCoverageEntry } from "#render-preparation/mask-frame-artifact";
import type {
  AlphaMask as PixiAlphaMask,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type RegionCoverageMaskMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type AlphaMaskConstructor = new (options: {
  mask: RegionCoverageMaskMesh;
}) => PixiAlphaMask;

type ImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiImageSource;

type MeshConstructor = new (options: {
  geometry: PixiMeshGeometry;
  shader: PixiShader;
}) => RegionCoverageMaskMesh;

type MeshGeometryConstructor = new (options: {
  indices: Uint32Array;
  positions: Float32Array;
  shrinkBuffersToFit: boolean;
  topology: "triangle-list";
  uvs: Float32Array;
}) => PixiMeshGeometry;

type ShaderFactory = {
  from(options: {
    gl: { fragment: string; vertex: string };
    gpu: {
      fragment: { entryPoint: string; source: string };
      vertex: { entryPoint: string; source: string };
    };
    resources: Record<string, unknown>;
  }): PixiShader;
};

type UniformGroupConstructor = new (
  uniforms: Record<
    string,
    { type: "f32"; value: number } | { type: "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiRegionCoverageMaskArtifact {
  readonly texture: PixiTexture;
}

export interface PixiRegionCoverageMask {
  readonly display: RegionCoverageMaskMesh;
  readonly effect: PixiAlphaMask;
  render(options: {
    readonly artifact: PixiRegionCoverageMaskArtifact;
    readonly coverage: PreparedRegionMaskCoverageEntry;
    readonly crop: {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    };
    readonly flipHorizontal: boolean;
    readonly flipVertical: boolean;
    readonly height: number;
    readonly rotation: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  }): void;
  destroy(): void;
}

/**
 * Produces a per-detection alpha mask from a compact prepared coverage crop.
 * The crop is sampled and transformed entirely on the GPU; semantic RLE masks
 * never enter the playback hot path.
 */
export function createPixiRegionCoverageMask(options: {
  readonly AlphaMask: AlphaMaskConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
}): PixiRegionCoverageMask {
  const uniforms = new options.UniformGroup({
    uCrop: {
      type: "vec4<f32>",
      value: new Float32Array([0, 0, 1, 1]),
    },
    uMaskRegion: {
      type: "vec4<f32>",
      value: new Float32Array([0, 0, 1, 1]),
    },
  });
  const placeholderSource = new options.ImageSource({
    autoGenerateMipmaps: false,
    dynamic: false,
    height: 1,
    resource: createShaderPlaceholderCanvas(),
    scaleMode: "nearest",
    width: 1,
  });
  const geometry = new options.MeshGeometry({
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    positions: new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
    shrinkBuffersToFit: true,
    topology: "triangle-list",
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  });
  let shader = createShader();
  const display = new options.Mesh({ geometry, shader });
  const effect = new options.AlphaMask({ mask: display });

  return {
    destroy() {
      effect.destroy();
      display.destroy();
      destroyShaderKeepingProgram(shader);
      geometry.destroy();
      placeholderSource.destroy();
    },

    display,
    effect,

    render(renderOptions) {
      bindTexture(renderOptions.artifact.texture.source);
      uniforms.uniforms.uCrop = new Float32Array([
        renderOptions.crop.x,
        renderOptions.crop.y,
        renderOptions.crop.width,
        renderOptions.crop.height,
      ]);
      uniforms.uniforms.uMaskRegion = new Float32Array([
        renderOptions.coverage.x,
        renderOptions.coverage.y,
        renderOptions.coverage.width,
        renderOptions.coverage.height,
      ]);
      uniforms.update();
      display.position.set(renderOptions.x, renderOptions.y);
      display.scale.set(
        renderOptions.width * (renderOptions.flipHorizontal ? -1 : 1),
        renderOptions.height * (renderOptions.flipVertical ? -1 : 1),
      );
      display.rotation = renderOptions.rotation;
    },
  };

  function bindTexture(source: PixiImageSource) {
    try {
      shader.resources.uTexture = source;
      shader.resources.uSampler = source.style;
    } catch {
      destroyShaderKeepingProgram(shader);
      shader = createShader();
      display.shader = shader;
      shader.resources.uTexture = source;
      shader.resources.uSampler = source.style;
    }
  }

  function createShader() {
    return options.Shader.from({
      gl: {
        fragment: regionCoverageMaskFragmentShader,
        vertex: regionCoverageMaskVertexShader,
      },
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: regionCoverageMaskFragmentWgsl,
        },
        vertex: {
          entryPoint: "mainVertex",
          source: untintedMaskVertexWgsl,
        },
      },
      resources: {
        regionMaskUniforms: uniforms,
        uSampler: placeholderSource.style,
        uTexture: placeholderSource,
      },
    });
  }
}

const regionCoverageMaskVertexShader = `#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uCrop;
uniform vec4 uMaskRegion;

out vec2 vMaskUV;

void main(void) {
  mat3 modelViewProjectionMatrix =
    uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

  gl_Position =
    vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vec2 mediaPoint = uCrop.xy + aUV * uCrop.zw;
  vMaskUV = (mediaPoint - uMaskRegion.xy) / uMaskRegion.zw;
}
`;

const regionCoverageMaskFragmentShader = `#version 300 es
precision highp float;

in vec2 vMaskUV;

uniform sampler2D uTexture;

out vec4 finalColor;

void main(void) {
  if (any(lessThan(vMaskUV, vec2(0.0))) || any(greaterThan(vMaskUV, vec2(1.0)))) {
    finalColor = vec4(0.0);
    return;
  }
  float alpha = texture(uTexture, vMaskUV).r;
  finalColor = vec4(alpha);
}
`;

// Resolving the crop per fragment keeps the uniform block out of the vertex
// stage's bind group.
const regionCoverageMaskFragmentWgsl = `
struct RegionMaskUniforms {
  uCrop: vec4<f32>,
  uMaskRegion: vec4<f32>,
}

@group(2) @binding(0) var<uniform> regionMaskUniforms: RegionMaskUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

@fragment
fn mainFragment(@location(0) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  let mediaPoint =
    regionMaskUniforms.uCrop.xy + vUV * regionMaskUniforms.uCrop.zw;
  let maskUV =
    (mediaPoint - regionMaskUniforms.uMaskRegion.xy) /
    regionMaskUniforms.uMaskRegion.zw;

  if (any(maskUV < vec2<f32>(0.0)) || any(maskUV > vec2<f32>(1.0))) {
    return vec4<f32>(0.0);
  }

  return vec4<f32>(textureSampleLevel(uTexture, uSampler, maskUV, 0.0).r);
}
`;
