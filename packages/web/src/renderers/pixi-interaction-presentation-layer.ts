import {
  ID_MASK_STROKE_WIDTH_LANES,
  idMaskFillPaletteWgslField,
  idMaskPaletteGlsl,
  idMaskPaletteWgsl,
  idMaskStrokePaletteWgslField,
  idMaskStrokeWidthsWgslField,
} from "#renderers/mask-palette";
import {
  tintedMaskVertexGlsl,
  tintedMaskVertexWgsl,
} from "#renderers/mask-vertex";
import {
  createShaderPlaceholderCanvas,
  destroyShaderKeepingProgram,
} from "#renderers/pixi-shader-lifecycle";
import {
  createDetectionPickKey,
  DetectionPickTarget,
  rebaseDetectionPickToFrame,
} from "supervision-js-core";
import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { PreparedIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import { createPixiBoxLayer } from "#renderers/pixi-box-layer";
import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import { createPixiVectorLayer } from "#renderers/pixi-vector-layer";
import { BaseInteractionStyle } from "supervision-js-core";
import type { BoxStyle } from "supervision-js-core";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "supervision-js-core";
import type { Detection, DetectionFrame } from "supervision-js-core";
import type { DetectionPickResult } from "supervision-js-core";
import {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import type {
  PolygonStyle,
  PolylineStyle,
  KeypointStyle,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Text as PixiText,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

export const MAX_INTERACTION_STROKE_RADIUS = 12;

type PixiInteractionMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type ContainerConstructor = new () => PixiContainer;
type GraphicsConstructor = new () => PixiGraphics;
type TextConstructor = new (options: {
  text?: string;
  style?: unknown;
}) => PixiText;
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
}) => PixiInteractionMesh;
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
    | { size?: number; type: "f32"; value: Float32Array | number }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiInteractionMaskArtifact {
  readonly frame: PreparedIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiInteractionPresentationLayerFrameContext {
  readonly frame: DetectionFrame | undefined;
  readonly hoveredPick: DetectionPickResult | null;
  readonly idMaskArtifact?: PixiInteractionMaskArtifact | null;
  readonly mediaTime: number;
  readonly selectedPick: DetectionPickResult | null;
  readonly selectedPicks?: readonly DetectionPickResult[];
  readonly viewportScale?: number;
}

export interface PixiInteractionPresentationLayer {
  createDisplay(dimensions: {
    readonly width: number;
    readonly height: number;
  }): PixiContainer;
  drawFrame(context: PixiInteractionPresentationLayerFrameContext): void;
  setInteractionStyle(
    interactionStyle: InteractionStyle | null | undefined,
  ): void;
  destroy(): void;
}

interface ActiveInteractionPick {
  readonly context: InteractionStyleContext;
  readonly detection: Detection;
  readonly pick: DetectionPickResult;
  readonly presentation: InteractionPresentation;
}

export function createPixiInteractionPresentationLayer(options: {
  readonly Container: ContainerConstructor;
  readonly Graphics: GraphicsConstructor;
  readonly ImageSource?: ImageSourceConstructor;
  readonly Mesh?: MeshConstructor;
  readonly MeshGeometry?: MeshGeometryConstructor;
  readonly Shader?: ShaderFactory;
  readonly Text: TextConstructor;
  readonly UniformGroup?: UniformGroupConstructor;
  readonly interactionStyle?: InteractionStyle | null;
  readonly isDetectionVisible?: (detection: Detection) => boolean;
}): PixiInteractionPresentationLayer {
  let interactionStyle: InteractionStyle | null =
    options.interactionStyle === undefined
      ? new BaseInteractionStyle()
      : options.interactionStyle;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let syntheticFrame: DetectionFrame | undefined;
  let activePicks: readonly ActiveInteractionPick[] = [];
  let currentMediaTime = 0;
  let viewportScale = 1;
  let maskRenderer: InteractionMaskRenderer | undefined;
  let isDestroyed = false;

  const syntheticTimeline = createSyntheticTimeline(() => syntheticFrame);
  const boxStyle = createInteractionBoxStyle(() => activePicks);
  const labelStyle = createInteractionLabelStyle(() => activePicks);
  const polygonStyle = createInteractionPolygonStyle(() => activePicks);
  const polylineStyle = createInteractionPolylineStyle(() => activePicks);
  const keypointStyle = createInteractionKeypointStyle(() => activePicks);
  const boxLayer = createPixiBoxLayer({
    boxStyle,
    detectionTimeline: syntheticTimeline,
  });
  const labelLayer = createPixiLabelLayer({
    Container: options.Container,
    Graphics: options.Graphics,
    Text: options.Text,
    detectionTimeline: syntheticTimeline,
    labelStyle,
  });
  const vectorLayer = createPixiVectorLayer({
    Container: options.Container,
    Graphics: options.Graphics,
    detectionTimeline: syntheticTimeline,
    polygonStyle,
    polylineStyle,
    keypointStyle,
  });

  return {
    createDisplay({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      const container = new options.Container();

      const boxGraphics = new options.Graphics();
      const labels = labelLayer.createContainer();
      const vectors = vectorLayer.createContainer();

      boxLayer.attachGraphics(boxGraphics);
      maskRenderer = createMaskRenderer();

      if (maskRenderer) {
        container.addChild(maskRenderer.mesh);
      }

      container.addChild(boxGraphics, vectors, labels);

      return container;
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      syntheticFrame = undefined;
      activePicks = [];
      maskRenderer?.destroy();
      labelLayer.destroy();
      vectorLayer.destroy();
    },

    drawFrame(context) {
      currentMediaTime = context.mediaTime;
      viewportScale = context.viewportScale ?? 1;

      if (isDestroyed || !interactionStyle || !context.frame) {
        clear();
        return;
      }

      activePicks = getActivePicks(context);

      if (activePicks.length === 0) {
        clear();
        return;
      }

      syntheticFrame = {
        detections: activePicks.map(({ detection }) =>
          detection.id === undefined
            ? detection
            : { ...detection, id: undefined },
        ),
        frameIndex: context.frame.frameIndex,
        mediaTime: context.frame.mediaTime,
      };

      drawMasks(context.idMaskArtifact);
      boxLayer.setBoxStyle(boxStyle);
      boxLayer.drawFrame(currentMediaTime, viewportScale);
      vectorLayer.setStyles({ polygonStyle, polylineStyle, keypointStyle });
      vectorLayer.drawFrame(currentMediaTime, viewportScale);
      labelLayer.setLabelStyle(labelStyle);
      labelLayer.drawFrame(currentMediaTime, viewportScale);
    },

    setInteractionStyle(nextInteractionStyle) {
      if (nextInteractionStyle === undefined) {
        return;
      }

      interactionStyle = nextInteractionStyle;
      boxLayer.setBoxStyle(boxStyle);
      labelLayer.setLabelStyle(labelStyle);
      vectorLayer.setStyles({ polygonStyle, polylineStyle, keypointStyle });
    },
  };

  function getActivePicks({
    frame,
    hoveredPick,
    mediaTime,
    selectedPick,
    selectedPicks,
  }: PixiInteractionPresentationLayerFrameContext) {
    if (!frame || !interactionStyle) {
      return [];
    }

    const picks = [
      ...(selectedPicks ?? (selectedPick ? [selectedPick] : [])).map((pick) =>
        createActivePick(
          pick,
          frame,
          mediaTime,
          DetectionInteractionState.Selected,
        ),
      ),
      createActivePick(
        selectedPicks ? null : selectedPick,
        frame,
        mediaTime,
        DetectionInteractionState.Selected,
      ),
      createActivePick(
        hoveredPick,
        frame,
        mediaTime,
        DetectionInteractionState.Hovered,
      ),
    ].filter((pick): pick is ActiveInteractionPick => pick !== null);
    const seenKeys = new Set<string>();
    const deduped: ActiveInteractionPick[] = [];

    for (const pick of picks) {
      const key = createDetectionPickKey(pick.pick);

      if (!key || seenKeys.has(key)) {
        if (
          key &&
          pick.context.state === DetectionInteractionState.Hovered &&
          pick.pick.target === DetectionPickTarget.Keypoint
        ) {
          const duplicateIndex = deduped.findIndex(
            (candidate) => createDetectionPickKey(candidate.pick) === key,
          );
          if (duplicateIndex !== -1) deduped[duplicateIndex] = pick;
        }
        continue;
      }

      seenKeys.add(key);
      deduped.push(pick);
    }

    return deduped;
  }

  function createActivePick(
    pick: DetectionPickResult | null,
    frame: DetectionFrame,
    mediaTime: number,
    state: DetectionInteractionState,
  ): ActiveInteractionPick | null {
    const activePick = rebaseDetectionPickToFrame(pick, frame);

    if (
      !activePick ||
      options.isDetectionVisible?.(activePick.detection) === false
    ) {
      return null;
    }

    const context = {
      detectionIndex: activePick.detectionIndex,
      frame: activePick.frame,
      geometryIndex: activePick.geometryIndex,
      mediaTime,
      point: activePick.point,
      state,
      target: activePick.target,
      viewportScale,
      hovered: state === DetectionInteractionState.Hovered,
      selected: state === DetectionInteractionState.Selected,
    };
    const presentation = resolvePresentation(activePick.detection, context);

    if (!hasRenderableInteractionPresentation(presentation)) {
      return null;
    }

    return {
      context,
      detection: activePick.detection,
      pick: activePick,
      presentation,
    };
  }

  function resolvePresentation(
    detection: Detection,
    context: InteractionStyleContext,
  ) {
    return interactionStyle?.resolve(detection, context);
  }

  function clear() {
    syntheticFrame = undefined;
    activePicks = [];
    maskRenderer?.hide();
    boxLayer.setBoxStyle(null);
    boxLayer.drawFrame(currentMediaTime, viewportScale);
    labelLayer.setLabelStyle(null);
    labelLayer.drawFrame(currentMediaTime, viewportScale);
    vectorLayer.setStyles({
      polygonStyle: null,
      polylineStyle: null,
      keypointStyle: null,
    });
    vectorLayer.drawFrame(currentMediaTime, viewportScale);
  }

  function drawMasks(artifact: PixiInteractionMaskArtifact | null | undefined) {
    if (!maskRenderer || !artifact) {
      maskRenderer?.hide();
      return;
    }

    const instructions = activePicks
      .map((activePick) => {
        const maskStyle = activePick.presentation.maskStyle;

        if (!maskStyle) {
          return undefined;
        }

        const instruction = maskStyle.resolve(activePick.detection, {
          detectionIndex: activePick.pick.detectionIndex,
          frame: activePick.pick.frame,
          mediaTime: activePick.context.mediaTime,
          viewportScale: activePick.context.viewportScale,
          hovered: activePick.context.hovered,
          selected: activePick.context.selected,
        });

        if (!instruction) {
          return undefined;
        }

        return {
          detectionIndex: activePick.pick.detectionIndex,
          instruction: applyMaskStyleOpacity(instruction, maskStyle),
        };
      })
      .filter((instruction): instruction is NonNullable<typeof instruction> =>
        Boolean(instruction),
      );

    if (instructions.length === 0) {
      maskRenderer.hide();
      return;
    }

    maskRenderer.render(artifact.frame, artifact.texture, instructions);
  }

  function createMaskRenderer() {
    if (
      !options.ImageSource ||
      !options.Mesh ||
      !options.MeshGeometry ||
      !options.Shader ||
      !options.UniformGroup ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return undefined;
    }

    return createInteractionMaskRenderer({
      ImageSource: options.ImageSource,
      Mesh: options.Mesh,
      MeshGeometry: options.MeshGeometry,
      Shader: options.Shader,
      UniformGroup: options.UniformGroup,
      mediaHeight,
      mediaWidth,
    });
  }
}

function createInteractionBoxStyle(
  getActivePicks: () => readonly ActiveInteractionPick[],
): BoxStyle {
  return {
    resolve(_detection, context) {
      const activePick = getActivePicks()[context.detectionIndex];
      const boxStyle = activePick?.presentation.boxStyle;

      if (!activePick || !boxStyle) {
        return undefined;
      }

      return boxStyle.resolve(activePick.detection, {
        detectionIndex: activePick.pick.detectionIndex,
        frame: activePick.pick.frame,
        mediaTime: activePick.context.mediaTime,
        viewportScale: context.viewportScale,
        hovered: activePick.context.hovered,
        selected: activePick.context.selected,
      });
    },
  };
}

function createInteractionLabelStyle(
  getActivePicks: () => readonly ActiveInteractionPick[],
): LabelStyle {
  return {
    resolve(_detection, context) {
      const activePick = getActivePicks()[context.detectionIndex];
      const labelStyle = activePick?.presentation.labelStyle;

      if (!activePick || !labelStyle) {
        return undefined;
      }

      return labelStyle.resolve(activePick.detection, {
        detectionIndex: activePick.pick.detectionIndex,
        frame: activePick.pick.frame,
        mediaTime: activePick.context.mediaTime,
        viewportScale: context.viewportScale,
        hovered: activePick.context.hovered,
        selected: activePick.context.selected,
      });
    },
  };
}

function hasRenderableInteractionPresentation(
  presentation: InteractionPresentation | undefined,
): presentation is InteractionPresentation {
  return Boolean(
    presentation?.boxStyle ||
    presentation?.labelStyle ||
    presentation?.maskStyle ||
    presentation?.polygonStyle ||
    presentation?.polylineStyle ||
    presentation?.keypointStyle,
  );
}

function createInteractionPolygonStyle(
  getActivePicks: () => readonly ActiveInteractionPick[],
): PolygonStyle {
  return {
    resolve(_detection, context) {
      const active = getActivePicks()[context.detectionIndex];
      return active?.presentation.polygonStyle?.resolve(active.detection, {
        ...context,
        detectionIndex: active.pick.detectionIndex,
        frame: active.pick.frame,
        hovered: active.context.hovered,
        selected: active.context.selected,
      });
    },
  };
}

function createInteractionPolylineStyle(
  getActivePicks: () => readonly ActiveInteractionPick[],
): PolylineStyle {
  return {
    resolve(_detection, context) {
      const active = getActivePicks()[context.detectionIndex];
      return active?.presentation.polylineStyle?.resolve(active.detection, {
        ...context,
        detectionIndex: active.pick.detectionIndex,
        frame: active.pick.frame,
        hovered: active.context.hovered,
        selected: active.context.selected,
      });
    },
  };
}

function createInteractionKeypointStyle(
  getActivePicks: () => readonly ActiveInteractionPick[],
): KeypointStyle {
  return {
    resolve(_detection, context) {
      const active = getActivePicks()[context.detectionIndex];
      return active?.presentation.keypointStyle?.resolve(active.detection, {
        ...context,
        detectionIndex: active.pick.detectionIndex,
        frame: active.pick.frame,
        hovered: active.context.hovered,
        selected: active.context.selected,
      });
    },
  };
}

function createSyntheticTimeline(
  getFrame: () => DetectionFrame | undefined,
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames() {
      const frame = getFrame();

      return frame ? [frame] : [];
    },
    getState() {
      const frame = getFrame();

      return {
        bufferEndTime: frame?.endTime ?? frame?.mediaTime ?? null,
        bufferStartTime: frame?.mediaTime ?? null,
        detectionCount: frame?.detections.length ?? 0,
        errorMessage: null,
        frameCount: frame ? 1 : 0,
        requestedEndTime: frame?.endTime ?? frame?.mediaTime ?? null,
        requestedStartTime: frame?.mediaTime ?? null,
        status: DetectionBufferStatus.Ready,
      };
    },
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: () => getFrame(),
  };
}

function applyMaskStyleOpacity(
  instruction: NonNullable<ReturnType<MaskStyle["resolve"]>>,
  maskStyle: MaskStyle,
) {
  const opacity = maskStyle.opacity ?? 1;

  if (opacity === 1) {
    return instruction;
  }

  return {
    ...instruction,
    alpha: instruction.alpha * opacity,
    stroke: instruction.stroke
      ? {
          ...instruction.stroke,
          alpha: instruction.stroke.alpha * opacity,
        }
      : undefined,
  };
}

interface InteractionMaskInstruction {
  readonly detectionIndex: number;
  readonly instruction: NonNullable<ReturnType<MaskStyle["resolve"]>>;
}

interface InteractionMaskRenderer {
  readonly mesh: PixiInteractionMesh;
  hide(): void;
  render(
    frame: PreparedIdMaskFrame,
    texture: PixiTexture,
    instructions: readonly InteractionMaskInstruction[],
  ): void;
  destroy(): void;
}

function createInteractionMaskRenderer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): InteractionMaskRenderer {
  const fillPalette = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokePalette = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  const strokeWidths = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  const uniforms = new options.UniformGroup({
    uFillPalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: fillPalette,
    },
    uMaxStrokeWidth: { type: "f32", value: 0 },
    uStrokePalette: {
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "vec4<f32>",
      value: strokePalette,
    },
    uStrokeWidths: {
      size: ID_MASK_STROKE_WIDTH_LANES,
      type: "vec4<f32>",
      value: strokeWidths,
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

    render(frame, texture, instructions) {
      if (frame.kind !== PreparedMaskFrameKind.IdMask) {
        mesh.visible = false;
        return;
      }

      bindTexture(texture.source);
      fillPalette.fill(0);
      strokePalette.fill(0);
      strokeWidths.fill(0);

      let maxStrokeWidth = 0;

      for (const { detectionIndex, instruction } of instructions) {
        const maskId = detectionIndex + 1;

        if (maskId <= 0 || maskId >= MAX_ID_MASK_PALETTE_ENTRIES) {
          continue;
        }

        writePaletteEntry(
          fillPalette,
          maskId,
          instruction.color,
          instruction.alpha,
        );

        if (instruction.stroke && instruction.stroke.width > 0) {
          writePaletteEntry(
            strokePalette,
            maskId,
            instruction.stroke.color,
            instruction.stroke.alpha,
          );
          strokeWidths[maskId] = Math.min(
            resolveRasterStrokeTexels(
              instruction.stroke.width,
              instruction.mask.width,
              frame.width,
            ),
            MAX_INTERACTION_STROKE_RADIUS,
          );
          maxStrokeWidth = Math.max(maxStrokeWidth, strokeWidths[maskId] ?? 0);
        }
      }

      uniforms.uniforms.uFillPalette = fillPalette;
      uniforms.uniforms.uStrokePalette = strokePalette;
      uniforms.uniforms.uStrokeWidths = strokeWidths;
      uniforms.uniforms.uTextureSize = new Float32Array([
        frame.width,
        frame.height,
      ]);
      uniforms.uniforms.uMaxStrokeWidth = Math.min(
        maxStrokeWidth,
        MAX_INTERACTION_STROKE_RADIUS,
      );
      uniforms.update();
      mesh.visible = true;
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
        fragment: interactionMaskFragmentShader,
        vertex: tintedMaskVertexGlsl,
      },
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: interactionMaskFragmentWgsl,
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

/**
 * A stroke is measured in texels of the raster the shader samples, so a raster
 * cooked below the mask's own resolution measures it in coarser texels. A
 * stroke of a texel or more keeps at least one, the thinnest line the shader
 * can draw; a narrower one keeps its own width, which the shader draws as an
 * inner boundary at any scale.
 */
function resolveRasterStrokeTexels(
  strokeWidth: number,
  maskWidth: number,
  rasterWidth: number,
) {
  const scale = maskWidth > 0 ? rasterWidth / maskWidth : 1;

  return Math.max(strokeWidth * scale, Math.min(strokeWidth, 1));
}

function writePaletteEntry(
  palette: Float32Array,
  maskId: number,
  color: number,
  alpha: number,
) {
  const offset = maskId * 4;
  const clampedAlpha = Math.max(0, Math.min(alpha, 1));

  palette[offset] = ((color >> 16) & 0xff) / 255;
  palette[offset + 1] = ((color >> 8) & 0xff) / 255;
  palette[offset + 2] = (color & 0xff) / 255;
  palette[offset + 3] = clampedAlpha;
}

const interactionMaskFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform vec2 uTextureSize;
uniform float uMaxStrokeWidth;
${idMaskPaletteGlsl}
out vec4 finalColor;

float sampleMaskId(vec2 uv) {
  return floor(texture(uTexture, uv).r * 255.0 + 0.5);
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
  int radius = int(min(uMaxStrokeWidth, float(${MAX_INTERACTION_STROKE_RADIUS})));

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

  if (centerId > 0.5) {
    vec4 fill = readFill(centerId);
    vec4 stroke = readStroke(centerId);

    if (
      uMaxStrokeWidth > 0.0 &&
      readStrokeWidth(centerId) > 0.0 &&
      stroke.a > 0.0 &&
      isBoundary(centerId, texel)
    ) {
      finalColor = premultiplyAlpha(stroke * vColor);
      return;
    }

    finalColor = premultiplyAlpha(fill * vColor);
    return;
  }

  if (uMaxStrokeWidth > 0.0) {
    float strokeId = findNeighborStrokeId(centerId, texel);

    if (strokeId > 0.5) {
      finalColor = premultiplyAlpha(readStroke(strokeId) * vColor);
      return;
    }
  }

  finalColor = vec4(0.0);
}
`;

const interactionMaskFragmentWgsl = `
struct InteractionMaskUniforms {
  ${idMaskFillPaletteWgslField}
  uMaxStrokeWidth: f32,
  ${idMaskStrokePaletteWgslField}
  ${idMaskStrokeWidthsWgslField}
  uTextureSize: vec2<f32>,
}

@group(2) @binding(0) var<uniform> maskUniforms: InteractionMaskUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

fn sampleMaskId(uv: vec2<f32>) -> f32 {
  return floor(textureSampleLevel(uTexture, uSampler, uv, 0.0).r * 255.0 + 0.5);
}
${idMaskPaletteWgsl}
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
  let radius = i32(min(maskUniforms.uMaxStrokeWidth, ${MAX_INTERACTION_STROKE_RADIUS}.0));

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

  if (centerId > 0.5) {
    let fill = readFill(centerId);
    let stroke = readStroke(centerId);

    if (
      maskUniforms.uMaxStrokeWidth > 0.0 &&
      readStrokeWidth(centerId) > 0.0 &&
      stroke.a > 0.0 &&
      isBoundary(vUV, centerId, texel)
    ) {
      return premultiplyAlpha(stroke * vColor);
    }

    return premultiplyAlpha(fill * vColor);
  }

  if (maskUniforms.uMaxStrokeWidth > 0.0) {
    let strokeId = findNeighborStrokeId(vUV, centerId, texel);

    if (strokeId > 0.5) {
      return premultiplyAlpha(readStroke(strokeId) * vColor);
    }
  }

  return vec4<f32>(0.0);
}
`;
