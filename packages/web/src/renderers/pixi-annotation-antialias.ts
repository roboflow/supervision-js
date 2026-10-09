import type { Filter as PixiFilter, UniformGroup } from "pixi.js";
import { annotationFxaaGl, annotationFxaaWgsl } from "./annotation-fxaa";

/** Smooths a captured annotation group without reading the media texture. */
export function createPixiAnnotationAntialiasFilter(options: {
  readonly Filter: Pick<typeof PixiFilter, "from">;
  readonly defaultFilterVert: string;
  readonly resolution?: number;
  readonly maskCoverage?: boolean;
}): PixiFilter {
  const source = createGpuSource(options.maskCoverage ?? false);
  const filter = options.Filter.from({
    antialias: false,
    resolution: options.resolution ?? 1,
    padding: 2,
    resources: options.maskCoverage
      ? {
          coverageAaUniforms: {
            uOutputOffset: {
              type: "vec4<f32>",
              value: new Float32Array([0, 0, 1, 0]),
            },
          },
        }
      : {},
    gl: {
      vertex: options.maskCoverage
        ? coverageFilterVert
        : options.defaultFilterVert,
      fragment: `#version 300 es
precision highp float;
in vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform vec4 uInputClamp;
uniform vec4 uInputPixel;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
out vec4 finalColor;

vec4 readColor(vec2 uv) {
  ${
    options.maskCoverage
      ? "return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));"
      : `vec2 lower = max(uInputClamp.xy, -uOutputFrame.xy * uInputSize.zw + 0.5 * uInputPixel.zw);
  vec2 upper = min(uInputClamp.zw, (uOutputTexture.xy - uOutputFrame.xy) * uInputSize.zw - 0.5 * uInputPixel.zw);
  return texture(uTexture, clamp(uv, lower, max(lower, upper)));`
  }
}

float contrastValue(vec4 color) {
  return dot(color.rgb, vec3(0.299, 0.587, 0.114)) + color.a;
}
${annotationFxaaGl}

void main(void) {
  finalColor = applyAnnotationFxaa(vTextureCoord);
}

`,
    },
    gpu: {
      vertex: { entryPoint: "mainVertex", source },
      fragment: { entryPoint: "mainFragment", source },
    },
  });

  if (options.maskCoverage) {
    filter.apply = (manager, input, output, clear) => {
      const uniforms = filter.resources.coverageAaUniforms as UniformGroup;
      const offset = uniforms.uniforms.uOutputOffset as Float32Array;
      const renderer = manager.renderer;
      const target = renderer.renderTarget.getRenderTarget(output);
      const global = renderer.globalUniforms.globalUniformData;
      // A mask target has its own origin outside Pixi's filter stack. The
      // global uniforms identify that target after the capture offset pops.
      offset[0] = global.offset.x;
      offset[1] = global.offset.y;
      offset[2] = target.resolution;
      offset[3] = global.resolution === target.size ? 1 : 0;
      uniforms.update();
      manager.applyFilter(filter, input, output, clear);
    };
  }
  return filter;
}

/** Keeps Pixi's power-of-two capture textures within the backend's limit. */
export function resolvePixiAnnotationAntialiasResolution(
  outputResolution: number,
  viewport: { readonly width: number; readonly height: number },
  maxTextureSize: number,
  captureScale: 1 | 2 = 1,
): number {
  const pooledLimit = 2 ** Math.floor(Math.log2(maxTextureSize));
  // Nested masks round logical bounds; FXAA adds two padding pixels per edge.
  const roundedSide = Math.max(
    1,
    Math.ceil(viewport.width) + 6,
    Math.ceil(viewport.height) + 6,
  );
  return Math.min(
    outputResolution * captureScale,
    Math.max(1, pooledLimit - 2) / roundedSide,
  );
}

const coverageFilterVert = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform vec4 uInputSize;
uniform vec4 uGlobalFrame;
uniform vec4 uOutputOffset;

void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  if (uOutputOffset.w > 0.0) {
    position -= uOutputOffset.xy - uGlobalFrame.xy / uOutputOffset.z;
  }
  gl_Position = vec4(
    position.x * (2.0 / uOutputTexture.x) - 1.0,
    position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z,
    0.0, 1.0
  );
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

function createGpuSource(maskCoverage: boolean) {
  return `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
}
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
${
  maskCoverage
    ? `struct CoverageAaUniforms { uOutputOffset: vec4<f32>, }
@group(1) @binding(0) var<uniform> coverageAaUniforms: CoverageAaUniforms;`
    : ""
}

struct FilterOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> FilterOutput {
  var out: FilterOutput;
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  ${
    maskCoverage
      ? `let offset = coverageAaUniforms.uOutputOffset;
  if (offset.w > 0.0) {
    position -= offset.xy - gfu.uGlobalFrame.xy / offset.z;
  }`
      : ""
  }
  out.position = vec4<f32>(
    position.x * (2.0 / gfu.uOutputTexture.x) - 1.0,
    position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z,
    0.0, 1.0
  );
  out.uv = aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  return out;
}

fn readColor(uv: vec2<f32>) -> vec4<f32> {
  ${
    maskCoverage
      ? "return textureSampleLevel(uTexture, uSampler, clamp(uv, gfu.uInputClamp.xy, gfu.uInputClamp.zw), 0.0);"
      : `let lower = max(gfu.uInputClamp.xy, -gfu.uOutputFrame.xy * gfu.uInputSize.zw + 0.5 * gfu.uInputPixel.zw);
  let upper = min(gfu.uInputClamp.zw, (gfu.uOutputTexture.xy - gfu.uOutputFrame.xy) * gfu.uInputSize.zw - 0.5 * gfu.uInputPixel.zw);
  return textureSampleLevel(uTexture, uSampler, clamp(uv, lower, max(lower, upper)), 0.0);`
  }
}

fn contrastValue(color: vec4<f32>) -> f32 {
  return dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114)) + color.a;
}
${annotationFxaaWgsl}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return applyAnnotationFxaa(uv);
}
`;
}
