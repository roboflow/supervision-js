import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import type {
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type PixiMaskHaloMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

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

export interface PixiBlurFilterLike {
  strength: number;
}

type BlurFilterConstructor = new (options: {
  strength: number;
  quality?: number;
}) => PixiBlurFilterLike;

export interface PixiMaskHaloRenderer {
  readonly mesh: PixiMaskHaloMesh;
  hide(): void;
  render(
    frame: PreparedPngIdMaskFrame,
    texture: PixiTexture,
    haloPalette: Float32Array,
    spread: number,
  ): void;
  setOpacity(opacity: number): void;
  destroy(): void;
}

/**
 * Renders a blurred, per-detection-colored copy of the prepared id mask
 * beneath the mask layer. The mesh maps mask ids through a halo palette and
 * a GPU blur filter turns that coverage into a smooth glow that follows the
 * exact mask silhouette, reusing the already-prepared mask texture.
 */
export function createPixiMaskHaloRenderer(options: {
  readonly BlurFilter: BlurFilterConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): PixiMaskHaloRenderer {
  const uniforms = new options.UniformGroup({
    uHaloPalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
  });
  const placeholderSource = new options.ImageSource({
    autoGenerateMipmaps: false,
    dynamic: false,
    height: 1,
    resource: createPlaceholderCanvas(),
    scaleMode: "nearest",
    width: 1,
  });
  const blurFilter = new options.BlurFilter({ quality: 4, strength: 8 });
  let shader = createShader();
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
  const mesh = new options.Mesh({ geometry, shader });

  mesh.visible = false;
  (mesh as { filters: unknown }).filters = [blurFilter];

  return {
    destroy() {
      mesh.destroy();
      shader.destroy(true);
      geometry.destroy();
      placeholderSource.destroy();
    },

    hide() {
      mesh.visible = false;
    },

    mesh,

    render(frame, texture, haloPalette, spread) {
      bindTexture(texture.source);
      uniforms.uniforms.uHaloPalette = haloPalette;
      uniforms.update();
      blurFilter.strength = Math.max(spread, 0);
      mesh.visible = true;
    },

    setOpacity(opacity) {
      mesh.alpha = opacity;
    },
  };

  function bindTexture(source: PixiImageSource) {
    try {
      shader.resources.uTexture = source;
      shader.resources.uSampler = source.style;
    } catch {
      rebuildShader();
      shader.resources.uTexture = source;
      shader.resources.uSampler = source.style;
    }
  }

  function createShader() {
    return options.Shader.from({
      gl: {
        fragment: maskHaloFragmentShader,
        vertex: maskHaloVertexShader,
      },
      resources: {
        haloUniforms: uniforms,
        uSampler: placeholderSource.style,
        uTexture: placeholderSource,
      },
    });
  }

  function rebuildShader() {
    try {
      shader.destroy(true);
    } catch {
      // Pixi has already invalidated this shader's resource group.
    }

    shader = createShader();
    mesh.shader = shader;
  }
}

/**
 * Builds the halo palette uniform: premultiplied halo color and alpha per
 * mask id, transparent for ids without a halo.
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
