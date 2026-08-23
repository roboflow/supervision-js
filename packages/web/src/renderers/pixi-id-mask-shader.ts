import { tintedMaskVertexWgsl } from "#renderers/mask-vertex-wgsl";
import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
} from "#render-preparation/mask-frame-compositor";
import type { PreparedIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import type {
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type PixiIdMaskMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type MeshConstructor = new (options: {
  geometry: PixiMeshGeometry;
  shader: PixiShader;
}) => PixiIdMaskMesh;

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
    | { size?: number; type: "f32"; value: Float32Array }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiIdMaskShaderRenderer {
  readonly mesh: PixiIdMaskMesh;
  clearTexture(): void;
  hide(): void;
  render(frame: PreparedIdMaskFrame, texture: PixiTexture): void;
  setOpacity(opacity: number): void;
  destroy(): void;
}

export function createPixiIdMaskShaderRenderer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
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
    uMaxStrokeWidth: { type: "f32", value: 0 },
    uStrokePalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
    uStrokeWidths: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "f32",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES),
    },
    uTextureSize: {
      type: "vec2<f32>",
      value: new Float32Array([options.mediaWidth, options.mediaHeight]),
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

  return {
    clearTexture() {
      bindTexture(placeholderSource);
    },

    destroy() {
      mesh.destroy();
      shader.destroy();
      geometry.destroy();
      placeholderSource.destroy();
    },

    hide() {
      mesh.visible = false;
    },

    mesh,

    render(frame, texture) {
      bindTexture(texture.source);
      uniforms.uniforms.uFillPalette = frame.fillPalette;
      uniforms.uniforms.uStrokePalette = frame.strokePalette;
      uniforms.uniforms.uStrokeWidths = frame.strokeWidths;
      uniforms.uniforms.uTextureSize = new Float32Array([
        frame.width,
        frame.height,
      ]);
      uniforms.uniforms.uBorderEnabled = frame.hasStroke ? 1 : 0;
      uniforms.uniforms.uMaxStrokeWidth = Math.min(
        frame.maxStrokeWidth,
        MAX_ID_MASK_STROKE_WIDTH,
      );
      uniforms.update();
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
        fragment: idMaskFragmentShader,
        vertex: idMaskVertexShader,
      },
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: idMaskFragmentWgsl,
        },
        vertex: {
          entryPoint: "mainVertex",
          source: tintedMaskVertexWgsl,
        },
      },
      resources: {
        maskUniforms: uniforms,
        uSampler: placeholderSource.style,
        uTexture: placeholderSource,
      },
    });
  }

  function rebuildShader() {
    try {
      // Never destroy(true): the program cache is keyed by source and shared
      // by every shader built from it; a destroyed entry poisons the rebuild.
      shader.destroy();
    } catch {
      // Pixi has already invalidated this shader's resource group.
    }

    shader = createShader();
    mesh.shader = shader;
  }
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
uniform float uStrokeWidths[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec2 uTextureSize;
uniform float uBorderEnabled;
uniform float uMaxStrokeWidth;

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

float readStrokeWidth(float maskId) {
  int paletteIndex = int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));

  return uStrokeWidths[paletteIndex];
}

vec4 premultiplyAlpha(vec4 color) {
  return vec4(color.rgb * color.a, color.a);
}

bool differs(float left, float right) {
  return abs(left - right) > 0.5;
}

// Offsets are whole texels, so the integer loop bounds are themselves the
// Chebyshev stroke-radius test: |offset| <= floor(w) iff |offset| <= w.
// The winning candidate is the max-(offsetY, offsetX) passing offset, so the
// scan runs backwards and exits on the first hit.
float findNeighborStrokeId(float centerId, vec2 texel) {
  int radius = int(min(uMaxStrokeWidth, float(${MAX_ID_MASK_STROKE_WIDTH})));

  for (int offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (int offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      float maskId = sampleMaskId(vUV + vec2(float(offsetX), float(offsetY)) * texel);

      if (maskId < 0.5 || !differs(maskId, centerId)) {
        continue;
      }

      float distance = max(abs(float(offsetX)), abs(float(offsetY)));

      if (readStrokeWidth(maskId) >= distance && readStroke(maskId).a > 0.0) {
        return maskId;
      }
    }
  }

  return 0.0;
}

bool isBoundary(float centerId, vec2 texel) {
  return
    differs(sampleMaskId(vUV + vec2(texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(vUV + vec2(-texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(vUV + vec2(0.0, texel.y)), centerId) ||
    differs(sampleMaskId(vUV + vec2(0.0, -texel.y)), centerId);
}

void main(void) {
  float centerId = sampleMaskId(vUV);
  vec2 texel = 1.0 / uTextureSize;

  if (centerId < 0.5) {
    if (uBorderEnabled > 0.5 && uMaxStrokeWidth > 0.0) {
      float borderId = findNeighborStrokeId(centerId, texel);

      if (borderId > 0.5) {
        finalColor = premultiplyAlpha(readStroke(borderId) * vColor);
        return;
      }
    }

    finalColor = vec4(0.0);
    return;
  }

  if (uBorderEnabled > 0.5) {
    bool shouldStroke =
      readStrokeWidth(centerId) > 0.0 &&
      readStroke(centerId).a > 0.0 &&
      isBoundary(centerId, texel);

    if (shouldStroke) {
      finalColor = premultiplyAlpha(readStroke(centerId) * vColor);
      return;
    }
  }

  finalColor = premultiplyAlpha(readFill(centerId) * vColor);
}
`;

// A WGSL uniform array needs a 16-byte element stride, while Pixi uploads an f32
// uniform array tightly packed, so uStrokeWidths is read back as vec4 lanes. That
// only lines up while the palette entry count stays a multiple of four.
const ID_MASK_STROKE_WIDTH_LANES = MAX_ID_MASK_PALETTE_ENTRIES / 4;

const idMaskFragmentWgsl = `
struct MaskUniforms {
  uBorderEnabled: f32,
  uFillPalette: array<vec4<f32>, ${MAX_ID_MASK_PALETTE_ENTRIES}>,
  uMaxStrokeWidth: f32,
  uStrokePalette: array<vec4<f32>, ${MAX_ID_MASK_PALETTE_ENTRIES}>,
  uStrokeWidths: array<vec4<f32>, ${ID_MASK_STROKE_WIDTH_LANES}>,
  uTextureSize: vec2<f32>,
}

@group(2) @binding(0) var<uniform> maskUniforms: MaskUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

fn sampleMaskId(uv: vec2<f32>) -> f32 {
  return floor(textureSampleLevel(uTexture, uSampler, uv, 0.0).r * 255.0 + 0.5);
}

fn paletteIndex(maskId: f32) -> i32 {
  return i32(clamp(maskId, 0.0, ${MAX_ID_MASK_PALETTE_ENTRIES - 1}.0));
}

fn readFill(maskId: f32) -> vec4<f32> {
  return maskUniforms.uFillPalette[paletteIndex(maskId)];
}

fn readStroke(maskId: f32) -> vec4<f32> {
  return maskUniforms.uStrokePalette[paletteIndex(maskId)];
}

fn readStrokeWidth(maskId: f32) -> f32 {
  let index = paletteIndex(maskId);

  return maskUniforms.uStrokeWidths[index / 4][index % 4];
}

fn premultiplyAlpha(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn differs(left: f32, right: f32) -> bool {
  return abs(left - right) > 0.5;
}

// Offsets are whole texels, so the integer loop bounds are themselves the
// Chebyshev stroke-radius test: |offset| <= floor(w) iff |offset| <= w.
// The winning candidate is the max-(offsetY, offsetX) passing offset, so the
// scan runs backwards and exits on the first hit.
fn findNeighborStrokeId(uv: vec2<f32>, centerId: f32, texel: vec2<f32>) -> f32 {
  let radius = i32(min(maskUniforms.uMaxStrokeWidth, ${MAX_ID_MASK_STROKE_WIDTH}.0));

  for (var offsetY = radius; offsetY >= -radius; offsetY -= 1) {
    for (var offsetX = radius; offsetX >= -radius; offsetX -= 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      let maskId = sampleMaskId(uv + vec2<f32>(f32(offsetX), f32(offsetY)) * texel);

      if (maskId < 0.5 || !differs(maskId, centerId)) {
        continue;
      }

      let offsetDistance = max(abs(f32(offsetX)), abs(f32(offsetY)));

      if (readStrokeWidth(maskId) >= offsetDistance && readStroke(maskId).a > 0.0) {
        return maskId;
      }
    }
  }

  return 0.0;
}

fn isBoundary(uv: vec2<f32>, centerId: f32, texel: vec2<f32>) -> bool {
  return
    differs(sampleMaskId(uv + vec2<f32>(texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(-texel.x, 0.0)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(0.0, texel.y)), centerId) ||
    differs(sampleMaskId(uv + vec2<f32>(0.0, -texel.y)), centerId);
}

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  let centerId = sampleMaskId(vUV);
  let texel = 1.0 / maskUniforms.uTextureSize;

  if (centerId < 0.5) {
    if (maskUniforms.uBorderEnabled > 0.5 && maskUniforms.uMaxStrokeWidth > 0.0) {
      let borderId = findNeighborStrokeId(vUV, centerId, texel);

      if (borderId > 0.5) {
        return premultiplyAlpha(readStroke(borderId) * vColor);
      }
    }

    return vec4<f32>(0.0);
  }

  if (maskUniforms.uBorderEnabled > 0.5) {
    let shouldStroke =
      readStrokeWidth(centerId) > 0.0 &&
      readStroke(centerId).a > 0.0 &&
      isBoundary(vUV, centerId, texel);

    if (shouldStroke) {
      return premultiplyAlpha(readStroke(centerId) * vColor);
    }
  }

  return premultiplyAlpha(readFill(centerId) * vColor);
}
`;
