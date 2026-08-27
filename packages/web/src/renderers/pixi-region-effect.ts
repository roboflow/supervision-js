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
  apply(display: PixiFilterDisplay): void;
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
  const filter = createFilter(options);

  if (!filter) {
    return undefined;
  }

  let display: PixiFilterDisplay | undefined;
  let destroyed = false;

  return {
    apply(nextDisplay) {
      if (destroyed) return;
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
        display.filters?.includes(filter)
      ) {
        display.filters = null;
      }
      display = nextDisplay;
      display.filters = [filter];
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (display?.filters?.includes(filter)) {
        display.filters = null;
      }
      filter.destroy?.();
      display = undefined;
    },
  };
}

function createFilter(options: {
  readonly BlurFilter?: BlurFilterConstructor;
  readonly defaultFilterVert?: string;
  readonly Filter?: FilterFactory;
  readonly effect: RegionRendererMediaEffect;
}): PixiFilter | undefined {
  if (options.effect.kind === RegionRendererMediaEffectKind.Blur) {
    if (!options.BlurFilter) return undefined;
    const strength = clampFinite(options.effect.strength, 8, 0, 64);
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
  const blockSize = clampFinite(options.effect.size, 12, 1, 128);
  const filter = options.Filter.from({
    gl: { fragment: pixelateFragmentShader, vertex: options.defaultFilterVert },
    gpu: undefined,
    resources: {
      regionEffectUniforms: {
        uBlockSize: { type: "f32", value: blockSize },
      },
    },
  });

  filter.padding = 0;
  return filter;
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
