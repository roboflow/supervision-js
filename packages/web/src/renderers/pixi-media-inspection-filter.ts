import type { Sprite } from "pixi.js";
import { computeMediaClahe } from "./media-clahe";
import { destroyShaderKeepingProgram } from "./pixi-shader-lifecycle";

const HISTOGRAM_MAX_DIMENSION = 1024;

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vImageCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform mat3 uImageMatrix;
void main() {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  vImageCoord = (uImageMatrix * vec3(vTextureCoord, 1.0)).xy;
}
`;

const fragment = `
in vec2 vTextureCoord;
in vec2 vImageCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uLut;
uniform vec2 uTiles;
uniform float uGamma;
uniform float uAuto;
float lookup(vec2 tile, float luma) {
  float row = tile.y * uTiles.x + tile.x;
  return texture(uLut, vec2((luma * 255.0 + 0.5) / 256.0,
    (row + 0.5) / (uTiles.x * uTiles.y))).r;
}
void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  if (color.a == 0.0) { finalColor = color; return; }
  vec3 rgb = color.rgb / color.a;
  if (uAuto > 0.5) {
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    vec2 tilePosition = clamp(vImageCoord, 0.0, 1.0) * uTiles - 0.5;
    vec2 t0 = floor(tilePosition);
    vec2 f = tilePosition - t0;
    vec2 t1 = clamp(t0 + 1.0, vec2(0.0), uTiles - 1.0);
    t0 = clamp(t0, vec2(0.0), uTiles - 1.0);
    float top = mix(lookup(t0, luma), lookup(vec2(t1.x, t0.y), luma), f.x);
    float bottom = mix(lookup(vec2(t0.x, t1.y), luma), lookup(t1, luma), f.x);
    rgb = clamp(rgb + (mix(top, bottom, f.y) - luma), 0.0, 1.0);
  }
  finalColor = vec4(pow(rgb, vec3(1.0 / uGamma)) * color.a, color.a);
}
`;

const gpuSource = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>, uInputPixel: vec4<f32>, uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>, uGlobalFrame: vec4<f32>, uOutputTexture: vec4<f32>,
};
struct InspectionUniforms {
  uImageMatrix: mat3x3<f32>, uTiles: vec2<f32>, uGamma: f32, uAuto: f32,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> inspectionUniforms: InspectionUniforms;
@group(1) @binding(1) var uLut: texture_2d<f32>;
@group(1) @binding(2) var uLutSampler: sampler;
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>, @location(1) image: vec2<f32>,
};
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> VertexOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  let uv = aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  return VertexOutput(vec4(position, 0.0, 1.0), uv,
    (inspectionUniforms.uImageMatrix * vec3(uv, 1.0)).xy);
}
fn lookup(tile: vec2<f32>, luma: f32) -> f32 {
  let tiles = inspectionUniforms.uTiles;
  let row = tile.y * tiles.x + tile.x;
  return textureSampleLevel(uLut, uLutSampler,
    vec2((luma * 255.0 + 0.5) / 256.0, (row + 0.5) / (tiles.x * tiles.y)), 0.0).r;
}
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(uTexture, uSampler, input.uv);
  if (color.a == 0.0) { return color; }
  var rgb = color.rgb / color.a;
  if (inspectionUniforms.uAuto > 0.5) {
    let luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    let tiles = inspectionUniforms.uTiles;
    let tilePosition = clamp(input.image, vec2(0.0), vec2(1.0)) * tiles - 0.5;
    let unbounded = floor(tilePosition);
    let f = tilePosition - unbounded;
    let t0 = clamp(unbounded, vec2(0.0), tiles - 1.0);
    let t1 = clamp(unbounded + 1.0, vec2(0.0), tiles - 1.0);
    let top = mix(lookup(t0, luma), lookup(vec2(t1.x, t0.y), luma), f.x);
    let bottom = mix(lookup(vec2(t0.x, t1.y), luma), lookup(t1, luma), f.x);
    rgb = clamp(rgb + (mix(top, bottom, f.y) - luma), vec3(0.0), vec3(1.0));
  }
  return vec4(pow(rgb, vec3(1.0 / inspectionUniforms.uGamma)) * color.a, color.a);
}
`;

export function createPixiMediaInspectionFilter(
  sprite: Sprite,
  pixi: Pick<
    typeof import("pixi.js"),
    "BufferImageSource" | "Filter" | "Matrix"
  >,
) {
  const { BufferImageSource, Filter, Matrix } = pixi;
  const pixels = new Uint8Array(256 * 64 * 4);
  const lutSource = new BufferImageSource({
    resource: pixels,
    width: 256,
    height: 64,
    scaleMode: "linear",
    alphaMode: "no-premultiply-alpha",
  });
  const filter = Filter.from({
    gl: { vertex: vertex, fragment: fragment },
    gpu: {
      vertex: { source: gpuSource, entryPoint: "mainVertex" },
      fragment: { source: gpuSource, entryPoint: "mainFragment" },
    },
    resolution: "inherit",
    resources: {
      inspectionUniforms: {
        uImageMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
        uTiles: { value: new Float32Array([8, 8]), type: "vec2<f32>" },
        uGamma: { value: 1, type: "f32" },
        uAuto: { value: 0, type: "f32" },
      },
      uLut: lutSource,
      uLutSampler: lutSource.style,
    },
  });
  const uniforms = filter.resources.inspectionUniforms.uniforms;
  let hasHistogram = false;

  filter.apply = (manager, input, output, clear) => {
    // The filter input is clipped by the viewport; lookup tiles stay anchored
    // to the full image when the user zooms or pans.
    manager.calculateSpriteMatrix(uniforms.uImageMatrix, sprite);
    manager.applyFilter(filter, input, output, clear);
  };

  return {
    filter,
    invalidateImage() {
      hasHistogram = false;
    },
    update(
      gamma: number,
      autoContrast: boolean,
      image: HTMLCanvasElement | null,
    ) {
      uniforms.uGamma = Math.max(gamma, 0.0001);
      if (autoContrast && image && !hasHistogram) {
        const scale = Math.min(
          1,
          HISTOGRAM_MAX_DIMENSION / Math.max(image.width, image.height),
        );
        const sample = document.createElement("canvas");
        sample.width = Math.max(1, Math.round(image.width * scale));
        sample.height = Math.max(1, Math.round(image.height * scale));
        const context = sample.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0, sample.width, sample.height);
        const { luts, tilesX, tilesY } = computeMediaClahe(
          context.getImageData(0, 0, sample.width, sample.height).data,
          sample.width,
          sample.height,
        );
        for (let i = 0; i < luts.length; i++) {
          pixels[i * 4] = luts[i]!;
          pixels[i * 4 + 1] = luts[i]!;
          pixels[i * 4 + 2] = luts[i]!;
          pixels[i * 4 + 3] = 255;
        }
        uniforms.uTiles.set([tilesX, tilesY]);
        lutSource.resource = pixels.subarray(0, luts.length * 4);
        lutSource.resize(256, tilesX * tilesY);
        lutSource.update();
        hasHistogram = true;
      }
      uniforms.uAuto = autoContrast && hasHistogram ? 1 : 0;
    },
    destroy() {
      destroyShaderKeepingProgram(filter);
      lutSource.destroy();
    },
  };
}
