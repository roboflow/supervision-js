import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "./injected-pixi";
import { tintedMaskVertexGlsl, untintedMaskVertexWgsl } from "./mask-vertex";
import { destroyShaderKeepingProgram } from "./pixi-shader-lifecycle";
import type { PixiFocusHeatmapArtifact } from "./pixi-focus-layer";
import type { Mesh, MeshGeometry, Shader, UniformGroup } from "pixi.js";

type HeatmapCutoutMesh = Mesh<MeshGeometry, Shader>;

/** Follows visible heatmap samples while preserving faint anomaly interiors. */
export function createPixiFocusHeatmapCutout(options: {
  readonly artifact: PixiFocusHeatmapArtifact;
  readonly Mesh: InjectedMeshConstructor<HeatmapCutoutMesh>;
  readonly MeshGeometry: InjectedMeshGeometryConstructor;
  readonly Shader: InjectedShaderFactory;
}) {
  const geometry = new options.MeshGeometry({
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    shrinkBuffersToFit: true,
    topology: "triangle-list",
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  });
  const shader = options.Shader.from({
    gl: { vertex: tintedMaskVertexGlsl, fragment: heatmapCutoutGlsl },
    gpu: {
      vertex: { source: untintedMaskVertexWgsl, entryPoint: "mainVertex" },
      fragment: { source: heatmapCutoutWgsl, entryPoint: "mainFragment" },
    },
    resources: {
      uTexture: options.artifact.texture.source,
      uSampler: options.artifact.texture.source.style,
      heatmapCoverageUniforms: {
        uAntialiasing: { value: 0, type: "f32" },
      },
    },
  });
  const display = new options.Mesh({ geometry, shader });
  const uniforms = shader.resources.heatmapCoverageUniforms as UniformGroup;

  return {
    display,
    render(artifact: PixiFocusHeatmapArtifact, antialiasing = false) {
      uniforms.uniforms.uAntialiasing = antialiasing ? 1 : 0;
      const { bounds } = artifact;
      display.position.set(
        bounds.x - bounds.width / 2,
        bounds.y - bounds.height / 2,
      );
      display.scale.set(bounds.width, bounds.height);
      display.visible = true;
    },
    destroy() {
      display.removeFromParent();
      display.destroy();
      destroyShaderKeepingProgram(shader);
      const buffer = uniforms.buffer;
      uniforms.buffer = undefined;
      buffer?.destroy();
      geometry.destroy();
    },
  };
}

const heatmapCutoutGlsl = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uTexture;
uniform float uAntialiasing;
out vec4 finalColor;

float visibleSample(ivec2 position, ivec2 dimensions) {
  return texelFetch(uTexture, clamp(position, ivec2(0), dimensions - ivec2(1)), 0).a > 0.0 ? 1.0 : 0.0;
}

void main(void) {
  float coverage;
  if (uAntialiasing > 0.0) {
    ivec2 dimensions = textureSize(uTexture, 0);
    vec2 position = vUV * vec2(dimensions) - 0.5;
    ivec2 base = ivec2(floor(position));
    vec2 weight = fract(position);
    coverage = mix(
      mix(visibleSample(base, dimensions), visibleSample(base + ivec2(1, 0), dimensions), weight.x),
      mix(visibleSample(base + ivec2(0, 1), dimensions), visibleSample(base + ivec2(1, 1), dimensions), weight.x),
      weight.y
    );
  } else {
    coverage = texture(uTexture, vUV).a > 0.0 ? 1.0 : 0.0;
  }
  finalColor = vec4(coverage);
}
`;

const heatmapCutoutWgsl = `
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
struct HeatmapCoverageUniforms {
  uAntialiasing: f32,
};
@group(2) @binding(2) var<uniform> heatmapCoverageUniforms: HeatmapCoverageUniforms;

fn visibleSample(position: vec2<i32>, dimensions: vec2<i32>) -> f32 {
  let alpha = textureLoad(uTexture, clamp(position, vec2<i32>(0), dimensions - vec2<i32>(1)), 0).a;
  return select(0.0, 1.0, alpha > 0.0);
}

@fragment
fn mainFragment(@location(0) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  var coverage: f32;
  if (heatmapCoverageUniforms.uAntialiasing > 0.0) {
    let dimensions = vec2<i32>(textureDimensions(uTexture));
    let position = vUV * vec2<f32>(dimensions) - 0.5;
    let base = vec2<i32>(floor(position));
    let weight = fract(position);
    coverage = mix(
      mix(visibleSample(base, dimensions), visibleSample(base + vec2<i32>(1, 0), dimensions), weight.x),
      mix(visibleSample(base + vec2<i32>(0, 1), dimensions), visibleSample(base + vec2<i32>(1, 1), dimensions), weight.x),
      weight.y
    );
  } else {
    let alpha = textureSampleLevel(uTexture, uSampler, vUV, 0.0).a;
    coverage = select(0.0, 1.0, alpha > 0.0);
  }
  return vec4<f32>(coverage);
}
`;
