import { tintedMaskVertexWgsl } from "#renderers/mask-vertex-wgsl";
import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import type {
  Detection,
  MaskHaloDrawInstruction,
  MaskHaloStyle,
  MaskHaloStyleContext,
  MaskStyle,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type PixiMaskHaloMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type ContainerConstructor = new () => PixiContainer;

type MeshConstructor = new (options: {
  geometry: PixiMeshGeometry;
  shader: PixiShader;
}) => PixiMaskHaloMesh;

type ImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiImageSource;

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
    | { type: "f32"; value: number }
    | { size?: number; type: "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

/**
 * The halo a detection actually paints, or `undefined`. A style may answer an
 * instruction that draws nothing, and both the coverage the halo prepares and
 * the passes it renders have to read that the same way: the raster carries one
 * detection id per pixel, so a detection admitted into the coverage but never
 * painted still claims its pixels and buries the ids the glow is drawn from.
 */
export function resolvePaintedMaskHalo(
  haloStyle: MaskHaloStyle,
  detection: Detection,
  context: MaskHaloStyleContext,
): MaskHaloDrawInstruction | undefined {
  if (!detection.mask) {
    return undefined;
  }

  const halo = haloStyle.resolve(detection, context);

  if (!halo || halo.alpha <= 0 || halo.spread <= 0) {
    return undefined;
  }

  return halo;
}

/**
 * The mask coverage a halo-only presentation prepares. Nothing here reaches the
 * screen, so the fill colour and alpha are arbitrary.
 */
export function createMaskHaloPreparationStyle(
  haloStyle: MaskHaloStyle,
  artifactKey: string,
): MaskStyle {
  return {
    artifactKey,
    resolve: (detection, context) => {
      const { mask } = detection;

      return mask && resolvePaintedMaskHalo(haloStyle, detection, context)
        ? { alpha: 0, color: 0x000000, mask }
        : undefined;
    },
  };
}

export interface PixiBlurFilterLike {
  strength: number;
}

type BlurFilterConstructor = new (options: {
  strength: number;
  quality?: number;
}) => PixiBlurFilterLike;

type RectangleConstructor = new (
  x: number,
  y: number,
  width: number,
  height: number,
) => unknown;

/**
 * One blur pass: every mask id whose halo requested the same spread renders
 * together, so each detection's public spread contract is honored exactly.
 */
export interface MaskHaloPassGroup {
  readonly palette: Float32Array;
  readonly spread: number;
}

export interface PixiMaskHaloRenderer {
  readonly display: PixiContainer;
  hide(): void;
  render(
    frame: { readonly height: number; readonly width: number },
    texture: PixiTexture,
    groups: readonly MaskHaloPassGroup[],
  ): void;
  setOpacity(opacity: number): void;
  destroy(): void;
}

/**
 * Renders blurred, per-detection-colored copies of the prepared id mask
 * beneath the mask layer. Each pass maps mask ids through a halo palette and
 * a GPU blur filter turns that coverage into a smooth glow following the
 * exact mask silhouette, reusing the already-prepared mask texture. Passes
 * are pooled and one runs per distinct spread.
 */
export function createPixiMaskHaloRenderer(options: {
  readonly BlurFilter: BlurFilterConstructor;
  readonly Container: ContainerConstructor;
  readonly Rectangle: RectangleConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): PixiMaskHaloRenderer {
  interface HaloPass {
    readonly blurFilter: PixiBlurFilterLike;
    readonly mesh: PixiMaskHaloMesh;
    shader: PixiShader;
    readonly uniforms: PixiUniformGroup;
  }

  const display = new options.Container();
  const placeholderSource = new options.ImageSource({
    autoGenerateMipmaps: false,
    dynamic: false,
    height: 1,
    resource: createPlaceholderCanvas(),
    scaleMode: "nearest",
    width: 1,
  });
  const geometry = new options.MeshGeometry({
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    positions: new Float32Array([
      0,
      0,
      options.mediaWidth,
      0,
      options.mediaWidth,
      options.mediaHeight,
      0,
      options.mediaHeight,
    ]),
    shrinkBuffersToFit: true,
    topology: "triangle-list",
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  });
  const passes: HaloPass[] = [];

  display.visible = false;

  return {
    destroy() {
      for (const pass of passes) {
        pass.mesh.destroy();
        pass.shader.destroy(true);
      }

      passes.length = 0;
      display.destroy();
      geometry.destroy();
      placeholderSource.destroy();
    },

    display,

    hide() {
      display.visible = false;
    },

    render(frame, texture, groups) {
      if (groups.length === 0) {
        display.visible = false;
        return;
      }

      for (const [index, group] of groups.entries()) {
        const pass = ensurePass(index);

        bindTexture(pass, texture.source);
        pass.uniforms.uniforms.uHaloPalette = group.palette;
        pass.uniforms.update();
        pass.blurFilter.strength = Math.max(group.spread, 0);
        pass.mesh.visible = true;
      }

      for (const pass of passes.slice(groups.length)) {
        pass.mesh.visible = false;
      }

      display.visible = true;
    },

    setOpacity(opacity) {
      display.alpha = opacity;
    },
  };

  function ensurePass(index: number): HaloPass {
    const existing = passes[index];

    if (existing) {
      return existing;
    }

    const uniforms = new options.UniformGroup({
      uHaloPalette: {
        size: MAX_ID_MASK_PALETTE_ENTRIES,
        type: "vec4<f32>",
        value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
      },
    });
    const shader = createShader(uniforms);
    const mesh = new options.Mesh({ geometry, shader });
    const blurFilter = new options.BlurFilter({ quality: 4, strength: 8 });

    // Filters size their working texture from measured bounds, and a
    // custom-geometry mesh measures empty; an explicit bounds area keeps the
    // blur pass covering the full media rect.
    (mesh as { boundsArea: unknown }).boundsArea = new options.Rectangle(
      0,
      0,
      options.mediaWidth,
      options.mediaHeight,
    );
    (mesh as { filters: unknown }).filters = [blurFilter];
    display.addChild(mesh);

    const pass: HaloPass = { blurFilter, mesh, shader, uniforms };

    passes.push(pass);

    return pass;
  }

  function bindTexture(pass: HaloPass, source: PixiImageSource) {
    try {
      pass.shader.resources.uTexture = source;
      pass.shader.resources.uSampler = source.style;
    } catch {
      try {
        pass.shader.destroy(true);
      } catch {
        // Pixi has already invalidated this shader's resource group.
      }

      pass.shader = createShader(pass.uniforms);
      pass.mesh.shader = pass.shader;
      pass.shader.resources.uTexture = source;
      pass.shader.resources.uSampler = source.style;
    }
  }

  function createShader(uniforms: PixiUniformGroup) {
    return options.Shader.from({
      gl: {
        fragment: maskHaloFragmentShader,
        vertex: maskHaloVertexShader,
      },
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: maskHaloFragmentWgsl,
        },
        vertex: {
          entryPoint: "mainVertex",
          source: tintedMaskVertexWgsl,
        },
      },
      resources: {
        haloUniforms: uniforms,
        uSampler: placeholderSource.style,
        uTexture: placeholderSource,
      },
    });
  }
}

/**
 * Builds one halo palette uniform: premultiplied halo color and alpha per
 * mask id, transparent for ids outside the group.
 */
export function buildMaskHaloPalette(
  halos: ReadonlyMap<
    number,
    { readonly alpha: number; readonly color: number }
  >,
): Float32Array {
  const palette = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);

  for (const [maskId, halo] of halos) {
    if (maskId <= 0 || maskId >= MAX_ID_MASK_PALETTE_ENTRIES) {
      continue;
    }

    const alpha = Math.max(0, Math.min(halo.alpha, 1));
    const offset = maskId * 4;

    palette[offset] = (((halo.color >> 16) & 0xff) / 255) * alpha;
    palette[offset + 1] = (((halo.color >> 8) & 0xff) / 255) * alpha;
    palette[offset + 2] = ((halo.color & 0xff) / 255) * alpha;
    palette[offset + 3] = alpha;
  }

  return palette;
}

function createPlaceholderCanvas() {
  const canvas = document.createElement("canvas");

  canvas.height = 1;
  canvas.width = 1;
  // WebGPU rejects a canvas that was never given a rendering context, and Pixi
  // uploads this placeholder while it builds the shader's first bind group.
  canvas.getContext("2d");

  return canvas;
}

const maskHaloVertexShader = `#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

out vec2 vUV;
out vec4 vColor;

void main(void) {
  mat3 modelViewProjectionMatrix =
    uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

  gl_Position =
    vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vColor = uWorldColorAlpha * uColor;
}
`;

const maskHaloFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform vec4 uHaloPalette[${MAX_ID_MASK_PALETTE_ENTRIES}];

out vec4 finalColor;

void main(void) {
  float maskId = floor(texture(uTexture, vUV).r * 255.0 + 0.5);
  int paletteIndex =
    int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));

  finalColor = uHaloPalette[paletteIndex] * vColor;
}
`;

const maskHaloFragmentWgsl = `
struct HaloUniforms {
  uHaloPalette: array<vec4<f32>, ${MAX_ID_MASK_PALETTE_ENTRIES}>,
}

@group(2) @binding(0) var<uniform> haloUniforms: HaloUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  let maskId = floor(textureSampleLevel(uTexture, uSampler, vUV, 0.0).r * 255.0 + 0.5);
  let paletteIndex = i32(clamp(maskId, 0.0, ${MAX_ID_MASK_PALETTE_ENTRIES - 1}.0));

  return haloUniforms.uHaloPalette[paletteIndex] * vColor;
}
`;
