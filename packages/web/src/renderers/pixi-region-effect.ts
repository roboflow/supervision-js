import {
  RegionRendererMediaEffectKind,
  type RegionRendererMediaEffect,
} from "supervision-js-core";
import type { Filter as PixiFilterClass } from "pixi.js";

type PixiFilter = {
  destroy?(): void;
  padding?: number;
};

type PixiFilterDisplay = {
  filters?: readonly PixiFilter[] | null;
};

type BlurFilterConstructor = new (options: {
  kernelSize?: number;
  quality?: number;
  repeatEdgePixels?: boolean;
  strength?: number;
}) => PixiFilter;

type FilterFactory = Pick<typeof PixiFilterClass, "from">;

export interface PixiRegionEffect {
  /**
   * Applies the effect at the current media-to-viewport scale.
   *
   * Public effect sizes are expressed in media pixels, while Pixi evaluates a
   * filter over the scaled display texture. Rebuild only when that scale
   * changes so the filter's rendered-pixel inputs remain semantically stable.
   */
  apply(display: PixiFilterDisplay, viewportScale?: number): void;
  destroy(): void;
}

/**
 * Creates one filter for one pooled region display.
 *
 * The public descriptor stays semantic. This browser-only primitive owns the
 * Pixi filter and is deliberately kept beneath the region layer so no filter,
 * shader, texture, or render target appears in the package API.
 */
export function createPixiRegionEffect(options: {
  readonly BlurFilter?: BlurFilterConstructor;
  readonly defaultFilterVert?: string;
  readonly Filter?: FilterFactory;
  readonly effect: RegionRendererMediaEffect;
}): PixiRegionEffect | undefined {
  if (
    (options.effect.kind === RegionRendererMediaEffectKind.Blur &&
      !options.BlurFilter) ||
    (options.effect.kind === RegionRendererMediaEffectKind.Pixelate &&
      (!options.Filter || !options.defaultFilterVert))
  ) {
    return undefined;
  }

  let filter: PixiFilter | undefined;
  let filterViewportScale: number | undefined;
  let display: PixiFilterDisplay | undefined;
  let destroyed = false;

  return {
    apply(nextDisplay, viewportScale = 1) {
      if (destroyed) return;
      const nextViewportScale = positiveFinite(viewportScale, 1);
      if (filterViewportScale !== nextViewportScale) {
        const nextFilter = createFilter(options, nextViewportScale);
        if (!nextFilter) return;
        detachFilter(display, filter);
        filter?.destroy?.();
        filter = nextFilter;
        filterViewportScale = nextViewportScale;
      }
      if (
        display === nextDisplay &&
        display.filters?.length === 1 &&
        display.filters[0] === filter
      ) {
        return;
      }
      if (
        display &&
        display !== nextDisplay &&
        filter &&
        display.filters?.includes(filter)
      ) {
        display.filters = null;
      }
      display = nextDisplay;
      if (filter) display.filters = [filter];
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      detachFilter(display, filter);
      filter?.destroy?.();
      filter = undefined;
      display = undefined;
    },
  };
}

function createFilter(
  options: {
    readonly BlurFilter?: BlurFilterConstructor;
    readonly defaultFilterVert?: string;
    readonly Filter?: FilterFactory;
    readonly effect: RegionRendererMediaEffect;
  },
  viewportScale: number,
): PixiFilter | undefined {
  if (options.effect.kind === RegionRendererMediaEffectKind.Blur) {
    if (!options.BlurFilter) return undefined;
    const strength =
      clampFinite(options.effect.strength, 8, 0, 64) * viewportScale;
    const filter = new options.BlurFilter({
      kernelSize: 5,
      quality: 2,
      repeatEdgePixels: true,
      strength,
    });

    // The crop sprite supplies the exact filter bounds. Padding keeps the blur
    // from clipping at its own source edge while repeatEdgePixels avoids
    // transparent fringes around bounded privacy regions.
    filter.padding = Math.ceil(strength * 2);
    return filter;
  }

  if (!options.Filter || !options.defaultFilterVert) return undefined;
  const blockSize =
    clampFinite(options.effect.size, 12, 1, 128) * viewportScale;
  const filter = options.Filter.from({
    gl: { fragment: pixelateFragmentShader, vertex: options.defaultFilterVert },
    gpu: {
      fragment: { entryPoint: "mainFragment", source: pixelateWgsl },
      vertex: { entryPoint: "mainVertex", source: pixelateWgsl },
    },
    resources: {
      regionEffectUniforms: {
        uBlockSize: { type: "f32", value: blockSize },
      },
    },
  });

  filter.padding = 0;
  return filter;
}

function detachFilter(
  display: PixiFilterDisplay | undefined,
  filter: PixiFilter | undefined,
) {
  if (filter && display?.filters?.includes(filter)) {
    display.filters = null;
  }
}

function positiveFinite(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampFinite(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const finite =
    value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, finite));
}

const pixelateFragmentShader = `#version 300 es
precision highp float;

in vec2 vTextureCoord;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform float uBlockSize;

out vec4 finalColor;

void main(void) {
  vec2 textureSize = max(uInputSize.xy, vec2(1.0));
  vec2 block = vec2(max(1.0, uBlockSize)) / textureSize;
  vec2 sampleUV = (floor(vTextureCoord / block) + 0.5) * block;
  finalColor = texture(uTexture, clamp(sampleUV, vec2(0.0), vec2(1.0)));
}
`;

// Pixi publishes its default filter vertex stage as GLSL alone, so the WebGPU
// side restates it here. Both stages live in one source because they share the
// filter's bind groups: the renderer owns group 0, and the filter's own
// uniforms follow in group 1.
const pixelateWgsl = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
}

struct RegionEffectUniforms {
  uBlockSize: f32,
}

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> regionEffectUniforms: RegionEffectUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VertexOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;

  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y =
    position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) -
    gfu.uOutputTexture.z;

  var output: VertexOutput;

  output.position = vec4<f32>(position, 0.0, 1.0);
  output.vTextureCoord = aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  return output;
}

@fragment
fn mainFragment(
  @location(0) vTextureCoord: vec2<f32>,
) -> @location(0) vec4<f32> {
  let textureSize = max(gfu.uInputSize.xy, vec2<f32>(1.0));
  let block =
    vec2<f32>(max(1.0, regionEffectUniforms.uBlockSize)) / textureSize;
  let sampleUV = (floor(vTextureCoord / block) + 0.5) * block;

  return textureSample(
    uTexture,
    uSampler,
    clamp(sampleUV, vec2<f32>(0.0), vec2<f32>(1.0)),
  );
}
`;
