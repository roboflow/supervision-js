import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import type {
  AlphaMask as PixiAlphaMask,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type RegionIdMaskMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type AlphaMaskConstructor = new (options: {
  mask: RegionIdMaskMesh;
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
}) => RegionIdMaskMesh;

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
    { type: "f32"; value: number } | { type: "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiRegionIdMaskArtifact {
  readonly frame: PreparedPngIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiRegionIdMask {
  readonly display: RegionIdMaskMesh;
  readonly effect: PixiAlphaMask;
  render(options: {
    readonly artifact: PixiRegionIdMaskArtifact;
    readonly crop: {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    };
    readonly flipHorizontal: boolean;
    readonly flipVertical: boolean;
    readonly height: number;
    readonly maskId: number;
    readonly mediaHeight: number;
    readonly mediaWidth: number;
    readonly rotation: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  }): void;
  destroy(): void;
}

/**
 * Produces a per-detection alpha mask from the renderer's prepared ID mask.
 * The crop is sampled and transformed entirely on the GPU; semantic RLE masks
 * never enter the playback hot path.
 */
export function createPixiRegionIdMask(options: {
  readonly AlphaMask: AlphaMaskConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
}): PixiRegionIdMask {
  const uniforms = new options.UniformGroup({
    uCrop: {
      type: "vec4<f32>",
      value: new Float32Array([0, 0, 1, 1]),
    },
    uMaskId: { type: "f32", value: 0 },
  });
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
      shader.destroy(true);
      geometry.destroy();
      placeholderSource.destroy();
    },

    display,
    effect,

    render(renderOptions) {
      bindTexture(renderOptions.artifact.texture.source);
      uniforms.uniforms.uCrop = new Float32Array([
        renderOptions.crop.x / renderOptions.mediaWidth,
        renderOptions.crop.y / renderOptions.mediaHeight,
        renderOptions.crop.width / renderOptions.mediaWidth,
        renderOptions.crop.height / renderOptions.mediaHeight,
      ]);
      uniforms.uniforms.uMaskId = renderOptions.maskId;
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
      try {
        shader.destroy(true);
      } catch {
        // Pixi may already have invalidated this shader resource group.
      }
      shader = createShader();
      display.shader = shader;
      shader.resources.uTexture = source;
      shader.resources.uSampler = source.style;
    }
  }

  function createShader() {
    return options.Shader.from({
      gl: {
        fragment: regionIdMaskFragmentShader,
        vertex: regionIdMaskVertexShader,
      },
      resources: {
        regionMaskUniforms: uniforms,
        uSampler: placeholderSource.style,
        uTexture: placeholderSource,
      },
    });
  }
}

function createPlaceholderCanvas() {
  if (typeof document === "undefined") {
    return { height: 1, width: 1 } as HTMLCanvasElement;
  }

  const canvas = document.createElement("canvas");
  canvas.height = 1;
  canvas.width = 1;
  return canvas;
}

const regionIdMaskVertexShader = `#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uCrop;

out vec2 vMaskUV;

void main(void) {
  mat3 modelViewProjectionMatrix =
    uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

  gl_Position =
    vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vMaskUV = uCrop.xy + aUV * uCrop.zw;
}
`;

const regionIdMaskFragmentShader = `#version 300 es
precision highp float;

in vec2 vMaskUV;

uniform sampler2D uTexture;
uniform float uMaskId;

out vec4 finalColor;

void main(void) {
  float sampledId = floor(texture(uTexture, vMaskUV).r * 255.0 + 0.5);
  float alpha = abs(sampledId - uMaskId) < 0.5 ? 1.0 : 0.0;
  finalColor = vec4(alpha);
}
`;
