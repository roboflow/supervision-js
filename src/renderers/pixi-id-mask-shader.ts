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

type MeshConstructor = new (options: {
  geometry: PixiMeshGeometry;
  shader: PixiShader;
}) => PixiMesh;

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

type TextureConstructor = {
  readonly EMPTY: PixiTexture;
  new (options: { dynamic: boolean; source: PixiImageSource }): PixiTexture;
};

type UniformGroupConstructor = new (
  uniforms: Record<
    string,
    | { type: "f32"; value: number }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiIdMaskShaderRenderer {
  readonly mesh: PixiMesh;
  hide(): void;
  render(frame: PreparedPngIdMaskFrame, texture: PixiTexture): void;
  setOpacity(opacity: number): void;
  destroy(): void;
}

export function createPixiIdMaskShaderRenderer(options: {
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly Texture: TextureConstructor;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): PixiIdMaskShaderRenderer {
  const uniforms = new options.UniformGroup({
    uBorderEnabled: { type: "f32", value: 0 },
    uFillPalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
    uStrokePalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
    uTextureSize: {
      type: "vec2<f32>",
      value: new Float32Array([options.mediaWidth, options.mediaHeight]),
    },
  });
  const shader = options.Shader.from({
    gl: {
      fragment: idMaskFragmentShader,
      vertex: idMaskVertexShader,
    },
    resources: {
      maskUniforms: uniforms,
      uSampler: options.Texture.EMPTY.source.style,
      uTexture: options.Texture.EMPTY.source,
    },
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
  const mesh = new options.Mesh({ geometry, shader });

  mesh.visible = false;

  return {
    destroy() {
      mesh.destroy();
      shader.destroy(true);
      geometry.destroy();
    },

    hide() {
      mesh.visible = false;
    },

    mesh,

    render(frame, texture) {
      shader.resources.uTexture = texture.source;
      shader.resources.uSampler = texture.source.style;
      uniforms.uniforms.uFillPalette = frame.fillPalette;
      uniforms.uniforms.uStrokePalette = frame.strokePalette;
      uniforms.uniforms.uTextureSize = new Float32Array([
        frame.width,
        frame.height,
      ]);
      uniforms.uniforms.uBorderEnabled = frame.hasStroke ? 1 : 0;
      uniforms.update();
      mesh.visible = true;
    },

    setOpacity(opacity) {
      mesh.alpha = opacity;
    },
  };
}

const idMaskVertexShader = `#version 300 es
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

const idMaskFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform vec4 uFillPalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec4 uStrokePalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec2 uTextureSize;
uniform float uBorderEnabled;

out vec4 finalColor;

float sampleMaskId(vec2 uv) {
  return floor(texture(uTexture, uv).r * 255.0 + 0.5);
}

vec4 readFill(float maskId) {
  int paletteIndex = int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));

  return uFillPalette[paletteIndex];
}

vec4 readStroke(float maskId) {
  int paletteIndex = int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));

  return uStrokePalette[paletteIndex];
}

bool differs(float left, float right) {
  return abs(left - right) > 0.5;
}

float neighboringMaskId(vec2 texel) {
  float right = sampleMaskId(vUV + vec2(texel.x, 0.0));
  float left = sampleMaskId(vUV + vec2(-texel.x, 0.0));
  float down = sampleMaskId(vUV + vec2(0.0, texel.y));
  float up = sampleMaskId(vUV + vec2(0.0, -texel.y));

  return max(max(right, left), max(down, up));
}

void main(void) {
  float centerId = sampleMaskId(vUV);
  vec2 texel = 1.0 / uTextureSize;

  if (centerId < 0.5) {
    if (uBorderEnabled > 0.5) {
      float borderId = neighboringMaskId(texel);

      if (borderId > 0.5) {
        finalColor = readStroke(borderId) * vColor;
        return;
      }
    }

    finalColor = vec4(0.0);
    return;
  }

  if (uBorderEnabled > 0.5) {
    bool isBoundary =
      differs(sampleMaskId(vUV + vec2(texel.x, 0.0)), centerId) ||
      differs(sampleMaskId(vUV + vec2(-texel.x, 0.0)), centerId) ||
      differs(sampleMaskId(vUV + vec2(0.0, texel.y)), centerId) ||
      differs(sampleMaskId(vUV + vec2(0.0, -texel.y)), centerId);

    if (isBoundary) {
      finalColor = readStroke(centerId) * vColor;
      return;
    }
  }

  finalColor = readFill(centerId) * vColor;
}
`;
