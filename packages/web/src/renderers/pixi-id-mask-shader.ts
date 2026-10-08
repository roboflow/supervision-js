import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "#renderers/injected-pixi";
import {
  idMaskStrokeCoverageGlsl,
  idMaskStrokeCoverageWgsl,
} from "#renderers/id-mask-stroke-coverage";
import {
  ID_MASK_STROKE_WIDTH_LANES,
  idMaskFillPaletteWgslField,
  idMaskPaletteGlsl,
  idMaskPaletteWgsl,
  idMaskStrokePaletteWgslField,
  idMaskStrokeWidthsWgslField,
  idMaskStrokeAlignmentsWgslField,
} from "#renderers/mask-palette";
import {
  tintedMaskVertexGlsl,
  tintedMaskVertexWgsl,
} from "#renderers/mask-vertex";
import {
  createShaderPlaceholderCanvas,
  destroyShaderKeepingProgram,
} from "#renderers/pixi-shader-lifecycle";
import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
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
    | { size?: number; type: "f32"; value: Float32Array }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiIdMaskShaderRenderer {
  readonly mesh: PixiIdMaskMesh;
  clearTexture(): void;
  releaseTexture(source: PixiImageSource): void;
  hide(): void;
  render(
    frame: PreparedIdMaskFrame,
    texture: PixiTexture,
    strokePixelRatio?: number,
  ): void;
  setOpacity(opacity: number): void;
  setStrokePixelRatio(pixelRatio: number): void;
  destroy(): void;
}

export function createPixiIdMaskShaderRenderer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: InjectedMeshConstructor<PixiIdMaskMesh>;
  readonly MeshGeometry: InjectedMeshGeometryConstructor;
  readonly Shader: InjectedShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): PixiIdMaskShaderRenderer {
  const defaultStrokeAlignments = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  const uniforms = new options.UniformGroup({
    uBorderEnabled: { type: "f32", value: 0 },
    uFillPalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
    uMaxStrokeWidth: { type: "f32", value: 0 },
    uStrokePixelRatio: { type: "f32", value: 1 },
    uStrokePalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
    },
    uStrokeWidths: {
      size: ID_MASK_STROKE_WIDTH_LANES,
      type: "vec4<f32>",
      value: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES),
    },
    uStrokeAlignments: {
      size: ID_MASK_STROKE_WIDTH_LANES,
      type: "vec4<f32>",
      value: defaultStrokeAlignments,
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
      bindTexture(placeholderSource);
    },

    releaseTexture(source) {
      if (shader.resources.uTexture !== source) return;
      bindTexture(placeholderSource);
      mesh.visible = false;
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

    render(frame, texture, strokePixelRatio = 1) {
      bindTexture(texture.source);
      uniforms.uniforms.uFillPalette = frame.fillPalette;
      uniforms.uniforms.uStrokePalette = frame.strokePalette;
      uniforms.uniforms.uStrokeWidths = frame.strokeWidths;
      uniforms.uniforms.uStrokeAlignments =
        frame.strokeAlignments ?? defaultStrokeAlignments;
      uniforms.uniforms.uStrokePixelRatio = strokePixelRatio;
      uniforms.uniforms.uTextureSize = new Float32Array([
        frame.width,
        frame.height,
      ]);
      uniforms.uniforms.uBorderEnabled = frame.hasStroke ? 1 : 0;
      uniforms.uniforms.uMaxStrokeWidth = frame.maxStrokeWidth;
      uniforms.update();
      mesh.visible = true;
    },

    setOpacity(opacity) {
      mesh.alpha = opacity;
    },

    setStrokePixelRatio(pixelRatio) {
      uniforms.uniforms.uStrokePixelRatio = pixelRatio;
      uniforms.update();
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
        vertex: tintedMaskVertexGlsl,
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
    destroyShaderKeepingProgram(shader);
    shader = createShader();
    mesh.shader = shader;
  }
}

const idMaskFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform vec2 uTextureSize;
uniform float uBorderEnabled;
uniform float uMaxStrokeWidth;
uniform float uStrokePixelRatio;
${idMaskPaletteGlsl}
out vec4 finalColor;

vec4 premultiplyAlpha(vec4 color) {
  return vec4(color.rgb * color.a, color.a);
}

bool differs(float left, float right) {
  return abs(left - right) > 0.5;
}

${idMaskStrokeCoverageGlsl}

void main(void) {
  vec2 position = vUV * uTextureSize;
  ivec2 sourceCell = ivec2(floor(position));
  float centerId = sampleMaskIdCell(sourceCell);
  vec2 cell = fract(position);
  vec2 footprint = fwidth(position);
  float pixelWidth = max(max(footprint.x, footprint.y), 0.00001);

  if (centerId < 0.5) {
    if (uBorderEnabled > 0.5) {
      vec2 border = findNeighborStroke(centerId, sourceCell, cell, pixelWidth);

      if (border.x > 0.5) {
        finalColor = premultiplyAlpha(readStroke(border.x) * vColor) * border.y;
        return;
      }
    }

    finalColor = vec4(0.0);
    return;
  }

  if (uBorderEnabled > 0.5) {
    float width = strokeWidthInTexels(centerId, pixelWidth);
    if (width > 0.0 && readStroke(centerId).a > 0.0) {
      float coverage = innerStrokeCoverage(centerId, sourceCell, cell, width, pixelWidth);
      if (coverage >= 1.0) {
        finalColor = premultiplyAlpha(readStroke(centerId) * vColor);
        return;
      }
      if (coverage > 0.0) {
        finalColor = mix(
          premultiplyAlpha(readFill(centerId) * vColor),
          premultiplyAlpha(readStroke(centerId) * vColor),
          coverage
        );
        return;
      }
    }
  }

  finalColor = premultiplyAlpha(readFill(centerId) * vColor);
}
`;

const idMaskFragmentWgsl = `
struct MaskUniforms {
  uBorderEnabled: f32,
  ${idMaskFillPaletteWgslField}
  uMaxStrokeWidth: f32,
  uStrokePixelRatio: f32,
  ${idMaskStrokePaletteWgslField}
  ${idMaskStrokeWidthsWgslField}
  ${idMaskStrokeAlignmentsWgslField}
  uTextureSize: vec2<f32>,
}

@group(2) @binding(0) var<uniform> maskUniforms: MaskUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

${idMaskPaletteWgsl}
fn premultiplyAlpha(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn differs(left: f32, right: f32) -> bool {
  return abs(left - right) > 0.5;
}

${idMaskStrokeCoverageWgsl}

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  let position = vUV * maskUniforms.uTextureSize;
  let sourceCell = vec2<i32>(floor(position));
  let centerId = sampleMaskIdCell(sourceCell);
  let cell = fract(position);
  let footprint = fwidth(position);
  let pixelWidth = max(max(footprint.x, footprint.y), 0.00001);

  if (centerId < 0.5) {
    if (maskUniforms.uBorderEnabled > 0.5) {
      let border = findNeighborStroke(centerId, sourceCell, cell, pixelWidth);

      if (border.x > 0.5) {
        return premultiplyAlpha(readStroke(border.x) * vColor) * border.y;
      }
    }

    return vec4<f32>(0.0);
  }

  if (maskUniforms.uBorderEnabled > 0.5) {
    let width = strokeWidthInTexels(centerId, pixelWidth);
    if (width > 0.0 && readStroke(centerId).a > 0.0) {
      let coverage = innerStrokeCoverage(centerId, sourceCell, cell, width, pixelWidth);
      if (coverage >= 1.0) {
        return premultiplyAlpha(readStroke(centerId) * vColor);
      }
      if (coverage > 0.0) {
        return mix(
          premultiplyAlpha(readFill(centerId) * vColor),
          premultiplyAlpha(readStroke(centerId) * vColor),
          coverage
        );
      }
    }
  }

  return premultiplyAlpha(readFill(centerId) * vColor);
}
`;
