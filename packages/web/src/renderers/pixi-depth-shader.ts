import type {
  DepthAnnotationRenderer,
  DepthColorMapping,
  DepthMap,
} from "supervision-js-core";
import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "#renderers/injected-pixi";
import {
  tintedMaskVertexGlsl,
  tintedMaskVertexWgsl,
} from "#renderers/mask-vertex";
import {
  createShaderPlaceholderCanvas,
  destroyShaderKeepingProgram,
} from "#renderers/pixi-shader-lifecycle";
import type {
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  TextureSource as PixiTextureSource,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

type PixiDepthMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

/**
 * Relative jump between neighbouring samples above which the edge-aware
 * filter treats them as two surfaces and keeps the nearest one.
 */
export const DEPTH_EDGE_RATIO = 0.05;

type ImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiImageSource;

type UniformGroupConstructor = new (
  uniforms: Record<
    string,
    | { type: "f32"; value: number }
    | { type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

/** Every value the depth fragment stage reads, in its uniform names. */
export interface DepthShaderUniforms {
  readonly uEdgeRatio: number;
  readonly uEncoding: number;
  readonly uInnerOffset: number;
  readonly uInvScale: number;
  readonly uMapSize: Float32Array;
  readonly uNearIsLow: number;
  readonly uNoDepthColor: Float32Array;
  readonly uNumerator: number;
  readonly uOuterOffset: number;
  readonly uPreviewHi: number;
  readonly uPreviewLo: number;
  readonly uRangeHi: number;
  readonly uRangeLo: number;
  readonly uReciprocal: number;
  readonly uReservedMax: number;
  readonly uSampling: number;
  readonly uWipe: number;
}

export interface PixiDepthShaderRenderer {
  readonly mesh: PixiDepthMesh;
  render(
    depthTexture: PixiTextureSource,
    lutTexture: PixiTextureSource,
    uniforms: DepthShaderUniforms,
  ): void;
  setOpacity(opacity: number): void;
  hide(): void;
  clearTexture(): void;
  destroy(): void;
}

/**
 * Shader terms for one map under one renderer. The quantity and range come
 * from core's mapping, the rest from the descriptor and the media size.
 * `texels` is the size of the image the texture holds, which is smaller than
 * the map when a map too large for the GPU went up decimated.
 */
export function resolveDepthShaderUniforms(
  map: DepthMap,
  mapping: DepthColorMapping,
  renderer: DepthAnnotationRenderer,
  media: { readonly width: number; readonly height: number },
  texels: { readonly width: number; readonly height: number } = map,
): DepthShaderUniforms {
  const { samples } = map;
  const sampling = renderer.sampling ?? "auto";
  const edgeAware =
    sampling === "edge-aware" ||
    (sampling === "auto" &&
      (texels.width < media.width || texels.height < media.height));
  const noDepthColor = renderer.noDepthColor ?? null;

  return {
    uEdgeRatio: DEPTH_EDGE_RATIO,
    uEncoding: samples.encoding === "scaled16" ? 0 : 1,
    uInnerOffset: mapping.innerOffset,
    uInvScale: samples.encoding === "scaled16" ? 1 / samples.scale : 1,
    uMapSize: new Float32Array([texels.width, texels.height]),
    uNearIsLow: mapping.nearIsLow ? 1 : 0,
    uNoDepthColor:
      noDepthColor === null
        ? new Float32Array(4)
        : new Float32Array([
            ((noDepthColor >> 16) & 0xff) / 255,
            ((noDepthColor >> 8) & 0xff) / 255,
            (noDepthColor & 0xff) / 255,
            1,
          ]),
    uNumerator: mapping.numerator,
    uOuterOffset: mapping.outerOffset,
    uPreviewHi: samples.encoding === "preview8" ? samples.range.max : 0,
    uPreviewLo: samples.encoding === "preview8" ? samples.range.min : 0,
    uRangeHi: mapping.hi,
    uRangeLo: mapping.lo,
    uReciprocal: mapping.reciprocal ? 1 : 0,
    uReservedMax: samples.encoding === "preview8" ? samples.reservedMax : 0,
    uSampling: edgeAware ? 1 : 0,
    uWipe: renderer.wipe ?? 1,
  };
}

/**
 * One mesh over the media rectangle that reads depth samples by texel,
 * converts them to the coloured quantity and looks the colour up in a 256x1
 * table. Opacity rides the mesh alpha, so changing it writes no uniform.
 */
export function createPixiDepthShaderRenderer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: InjectedMeshConstructor<PixiDepthMesh>;
  readonly MeshGeometry: InjectedMeshGeometryConstructor;
  readonly Shader: InjectedShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): PixiDepthShaderRenderer {
  const uniforms = new options.UniformGroup({
    uEdgeRatio: { type: "f32", value: DEPTH_EDGE_RATIO },
    uEncoding: { type: "f32", value: 0 },
    uInnerOffset: { type: "f32", value: 0 },
    uInvScale: { type: "f32", value: 1 },
    uMapSize: { type: "vec2<f32>", value: new Float32Array([1, 1]) },
    uNearIsLow: { type: "f32", value: 0 },
    uNoDepthColor: { type: "vec4<f32>", value: new Float32Array(4) },
    uNumerator: { type: "f32", value: 1 },
    uOuterOffset: { type: "f32", value: 0 },
    uPreviewHi: { type: "f32", value: 0 },
    uPreviewLo: { type: "f32", value: 0 },
    uRangeHi: { type: "f32", value: 1 },
    uRangeLo: { type: "f32", value: 0 },
    uReciprocal: { type: "f32", value: 0 },
    uReservedMax: { type: "f32", value: 0 },
    uSampling: { type: "f32", value: 0 },
    uWipe: { type: "f32", value: 1 },
  });
  const placeholderSource = new options.ImageSource({
    autoGenerateMipmaps: false,
    dynamic: false,
    height: 1,
    resource: createShaderPlaceholderCanvas(),
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
      bindTextures(placeholderSource, placeholderSource);
    },

    destroy() {
      mesh.destroy();
      destroyShaderKeepingProgram(shader);
      geometry.destroy();
      placeholderSource.destroy();
    },

    hide() {
      mesh.visible = false;
    },

    mesh,

    render(depthTexture, lutTexture, values) {
      bindTextures(depthTexture, lutTexture);
      Object.assign(uniforms.uniforms, values);
      uniforms.update();
      mesh.visible = true;
    },

    setOpacity(opacity) {
      mesh.alpha = opacity;
    },
  };

  function bindTextures(
    depthTexture: PixiTextureSource,
    lutTexture: PixiTextureSource,
  ) {
    try {
      assignTextures(depthTexture, lutTexture);
    } catch {
      rebuildShader();
      assignTextures(depthTexture, lutTexture);
    }
  }

  function assignTextures(
    depthTexture: PixiTextureSource,
    lutTexture: PixiTextureSource,
  ) {
    shader.resources.uDepthTexture = depthTexture;
    shader.resources.uLutTexture = lutTexture;
    shader.resources.uLutSampler = lutTexture.style;
  }

  function createShader() {
    return options.Shader.from({
      gl: {
        fragment: depthFragmentShader,
        vertex: tintedMaskVertexGlsl,
      },
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: depthFragmentWgsl,
        },
        vertex: {
          entryPoint: "mainVertex",
          source: tintedMaskVertexWgsl,
        },
      },
      resources: {
        depthUniforms: uniforms,
        uDepthTexture: placeholderSource,
        uLutSampler: placeholderSource.style,
        uLutTexture: placeholderSource,
      },
    });
  }

  function rebuildShader() {
    destroyShaderKeepingProgram(shader);
    shader = createShader();
    mesh.shader = shader;
  }
}

/*
 * Both programs read texels by integer position and never let the hardware
 * filter the packed bytes: a blend of two low bytes is not the low byte of a
 * blend. The edge-aware filter runs here on rebuilt values instead.
 *
 * Its nearest tap decides whether a pixel has depth at all, so holes keep the
 * outline nearest sampling gives them; the blend then uses only valid taps,
 * and a jump above uEdgeRatio between them keeps the nearest tap's value so a
 * foreground edge never fades into the background.
 */
const depthFragmentShader = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uDepthTexture;
uniform sampler2D uLutTexture;
uniform float uEdgeRatio;
uniform float uEncoding;
uniform float uInnerOffset;
uniform float uInvScale;
uniform vec2 uMapSize;
uniform float uNearIsLow;
uniform vec4 uNoDepthColor;
uniform float uNumerator;
uniform float uOuterOffset;
uniform float uPreviewHi;
uniform float uPreviewLo;
uniform float uRangeHi;
uniform float uRangeLo;
uniform float uReciprocal;
uniform float uReservedMax;
uniform float uSampling;
uniform float uWipe;

out vec4 finalColor;

// x is the value in the map kind's unit, y is 1 where the map has depth.
vec2 loadValue(ivec2 position) {
  ivec2 texel = clamp(position, ivec2(0), ivec2(uMapSize) - ivec2(1));
  vec4 bytes = texelFetch(uDepthTexture, texel, 0);

  if (uEncoding < 0.5) {
    float stored =
      floor(bytes.r * 255.0 + 0.5) + 256.0 * floor(bytes.g * 255.0 + 0.5);

    return vec2(stored * uInvScale, stored > 0.5 ? 1.0 : 0.0);
  }

  float code = floor(bytes.r * 255.0 + 0.5);

  if (code < uReservedMax + 0.5) {
    return vec2(0.0);
  }

  return vec2(
    uPreviewLo +
      (code - uReservedMax - 1.0) / (254.0 - uReservedMax) *
      (uPreviewHi - uPreviewLo),
    1.0
  );
}

vec2 sampleValue(vec2 uv) {
  vec2 position = uv * uMapSize;

  if (uSampling < 0.5) {
    return loadValue(ivec2(floor(position)));
  }

  vec2 corner = position - 0.5;
  ivec2 origin = ivec2(floor(corner));
  vec2 f = corner - floor(corner);
  vec2 taps[4] = vec2[4](
    loadValue(origin),
    loadValue(origin + ivec2(1, 0)),
    loadValue(origin + ivec2(0, 1)),
    loadValue(origin + ivec2(1, 1))
  );
  float weights[4] = float[4](
    (1.0 - f.x) * (1.0 - f.y),
    f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y,
    f.x * f.y
  );
  int nearest = 0;
  float weightSum = 0.0;
  float valueSum = 0.0;
  float lowest = 3.4e38;
  float highest = -3.4e38;

  for (int k = 0; k < 4; k += 1) {
    if (weights[k] > weights[nearest]) {
      nearest = k;
    }

    if (taps[k].y > 0.5) {
      weightSum += weights[k];
      valueSum += weights[k] * taps[k].x;
      lowest = min(lowest, taps[k].x);
      highest = max(highest, taps[k].x);
    }
  }

  if (taps[nearest].y < 0.5) {
    return vec2(0.0);
  }

  if (highest > lowest * (1.0 + uEdgeRatio)) {
    return taps[nearest];
  }

  return vec2(valueSum / weightSum, 1.0);
}

float colorCoordinate(float value) {
  float converted = uReciprocal > 0.5
    ? uNumerator / (value + uInnerOffset) + uOuterOffset
    : value;
  float t = clamp(
    (converted - uRangeLo) / max(uRangeHi - uRangeLo, 1e-20),
    0.0,
    1.0
  );

  return uNearIsLow > 0.5 ? 1.0 - t : t;
}

vec4 premultiplyAlpha(vec4 color) {
  return vec4(color.rgb * color.a, color.a);
}

void main(void) {
  if (vUV.x > uWipe) {
    finalColor = vec4(0.0);
    return;
  }

  vec2 depth = sampleValue(vUV);

  if (depth.y < 0.5) {
    finalColor = premultiplyAlpha(uNoDepthColor * vColor);
    return;
  }

  float t = colorCoordinate(depth.x);
  vec3 color = textureLod(
    uLutTexture,
    vec2((t * 255.0 + 0.5) / 256.0, 0.5),
    0.0
  ).rgb;

  finalColor = premultiplyAlpha(vec4(color, 1.0) * vColor);
}
`;

const depthFragmentWgsl = `
struct DepthUniforms {
  uEdgeRatio: f32,
  uEncoding: f32,
  uInnerOffset: f32,
  uInvScale: f32,
  uMapSize: vec2<f32>,
  uNearIsLow: f32,
  uNoDepthColor: vec4<f32>,
  uNumerator: f32,
  uOuterOffset: f32,
  uPreviewHi: f32,
  uPreviewLo: f32,
  uRangeHi: f32,
  uRangeLo: f32,
  uReciprocal: f32,
  uReservedMax: f32,
  uSampling: f32,
  uWipe: f32,
}

@group(2) @binding(0) var<uniform> depthUniforms: DepthUniforms;
@group(2) @binding(1) var uDepthTexture: texture_2d<f32>;
@group(2) @binding(2) var uLutTexture: texture_2d<f32>;
@group(2) @binding(3) var uLutSampler: sampler;

// x is the value in the map kind's unit, y is 1 where the map has depth.
fn loadValue(position: vec2<i32>) -> vec2<f32> {
  let texel = clamp(
    position,
    vec2<i32>(0),
    vec2<i32>(depthUniforms.uMapSize) - vec2<i32>(1)
  );
  let bytes = textureLoad(uDepthTexture, texel, 0);

  if (depthUniforms.uEncoding < 0.5) {
    let stored =
      floor(bytes.r * 255.0 + 0.5) + 256.0 * floor(bytes.g * 255.0 + 0.5);

    return vec2<f32>(
      stored * depthUniforms.uInvScale,
      select(0.0, 1.0, stored > 0.5)
    );
  }

  let code = floor(bytes.r * 255.0 + 0.5);

  if (code < depthUniforms.uReservedMax + 0.5) {
    return vec2<f32>(0.0);
  }

  return vec2<f32>(
    depthUniforms.uPreviewLo +
      (code - depthUniforms.uReservedMax - 1.0) /
      (254.0 - depthUniforms.uReservedMax) *
      (depthUniforms.uPreviewHi - depthUniforms.uPreviewLo),
    1.0
  );
}

fn sampleValue(uv: vec2<f32>) -> vec2<f32> {
  let position = uv * depthUniforms.uMapSize;

  if (depthUniforms.uSampling < 0.5) {
    return loadValue(vec2<i32>(floor(position)));
  }

  let corner = position - 0.5;
  let origin = vec2<i32>(floor(corner));
  let f = corner - floor(corner);
  var taps = array<vec2<f32>, 4>(
    loadValue(origin),
    loadValue(origin + vec2<i32>(1, 0)),
    loadValue(origin + vec2<i32>(0, 1)),
    loadValue(origin + vec2<i32>(1, 1))
  );
  var weights = array<f32, 4>(
    (1.0 - f.x) * (1.0 - f.y),
    f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y,
    f.x * f.y
  );
  var nearest = 0;
  var weightSum = 0.0;
  var valueSum = 0.0;
  var lowest = 3.4e38;
  var highest = -3.4e38;

  for (var k = 0; k < 4; k += 1) {
    if (weights[k] > weights[nearest]) {
      nearest = k;
    }

    if (taps[k].y > 0.5) {
      weightSum += weights[k];
      valueSum += weights[k] * taps[k].x;
      lowest = min(lowest, taps[k].x);
      highest = max(highest, taps[k].x);
    }
  }

  if (taps[nearest].y < 0.5) {
    return vec2<f32>(0.0);
  }

  if (highest > lowest * (1.0 + depthUniforms.uEdgeRatio)) {
    return taps[nearest];
  }

  return vec2<f32>(valueSum / weightSum, 1.0);
}

fn colorCoordinate(value: f32) -> f32 {
  var converted = value;

  if (depthUniforms.uReciprocal > 0.5) {
    converted =
      depthUniforms.uNumerator / (value + depthUniforms.uInnerOffset) +
      depthUniforms.uOuterOffset;
  }

  let t = clamp(
    (converted - depthUniforms.uRangeLo) /
      max(depthUniforms.uRangeHi - depthUniforms.uRangeLo, 1e-20),
    0.0,
    1.0
  );

  return select(t, 1.0 - t, depthUniforms.uNearIsLow > 0.5);
}

fn premultiplyAlpha(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  if (vUV.x > depthUniforms.uWipe) {
    return vec4<f32>(0.0);
  }

  let depth = sampleValue(vUV);

  if (depth.y < 0.5) {
    return premultiplyAlpha(depthUniforms.uNoDepthColor * vColor);
  }

  let t = colorCoordinate(depth.x);
  let color = textureSampleLevel(
    uLutTexture,
    uLutSampler,
    vec2<f32>((t * 255.0 + 0.5) / 256.0, 0.5),
    0.0
  ).rgb;

  return premultiplyAlpha(vec4<f32>(color, 1.0) * vColor);
}
`;
