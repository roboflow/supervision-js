import {
  createDetectionPickKey,
  rebaseDetectionPickToFrame,
} from "#interactions/detection-picker";
import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import { createPixiBoxLayer } from "#renderers/pixi-box-layer";
import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import { BaseInteractionStyle } from "#styles/interaction-style";
import type { BoxStyle } from "#types/box-style";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "#types/detection-timeline";
import type { Detection, DetectionFrame } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "#types/interaction-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
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

const MAX_INTERACTION_STROKE_RADIUS = 12;

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
  readonly frame: PreparedPngIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiInteractionPresentationLayerFrameContext {
  readonly frame: DetectionFrame | undefined;
  readonly hoveredPick: DetectionPickResult | null;
  readonly idMaskArtifact?: PixiInteractionMaskArtifact | null;
  readonly mediaTime: number;
  readonly selectedPick: DetectionPickResult | null;
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
  let maskRenderer: InteractionMaskRenderer | undefined;
  let isDestroyed = false;

  const syntheticTimeline = createSyntheticTimeline(() => syntheticFrame);
  const boxStyle = createInteractionBoxStyle(() => activePicks);
  const labelStyle = createInteractionLabelStyle(() => activePicks);
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

  return {
    createDisplay({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      const container = new options.Container();

      const boxGraphics = new options.Graphics();
      const labels = labelLayer.createContainer();

      boxLayer.attachGraphics(boxGraphics);
      maskRenderer = createMaskRenderer();

      if (maskRenderer) {
        container.addChild(maskRenderer.mesh);
      }

      container.addChild(boxGraphics, labels);

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
    },

    drawFrame(context) {
      currentMediaTime = context.mediaTime;

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
        detections: activePicks.map(({ detection }) => detection),
        frameIndex: context.frame.frameIndex,
        mediaTime: context.frame.mediaTime,
      };

      drawMasks(context.idMaskArtifact);
      boxLayer.setBoxStyle(boxStyle);
      boxLayer.drawFrame(currentMediaTime);
      labelLayer.setLabelStyle(labelStyle);
      labelLayer.drawFrame(currentMediaTime);
    },

    setInteractionStyle(nextInteractionStyle) {
      if (nextInteractionStyle === undefined) {
        return;
      }

      interactionStyle = nextInteractionStyle;
      boxLayer.setBoxStyle(boxStyle);
      labelLayer.setLabelStyle(labelStyle);
    },
  };

  function getActivePicks({
    frame,
    hoveredPick,
    mediaTime,
    selectedPick,
  }: PixiInteractionPresentationLayerFrameContext) {
    if (!frame || !interactionStyle) {
      return [];
    }

    const picks = [
      createActivePick(
        selectedPick,
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

    if (!activePick) {
      return null;
    }

    const context = {
      detectionIndex: activePick.detectionIndex,
      frame: activePick.frame,
      mediaTime,
      point: activePick.point,
      state,
      target: activePick.target,
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
    boxLayer.drawFrame(currentMediaTime);
    labelLayer.setLabelStyle(null);
    labelLayer.drawFrame(currentMediaTime);
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
    presentation?.maskStyle,
  );
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
    frame: PreparedPngIdMaskFrame,
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
      size: MAX_ID_MASK_PALETTE_ENTRIES,
      type: "f32",
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

    render(frame, texture, instructions) {
      if (frame.kind !== PreparedMaskFrameKind.PngIdMask) {
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
            Math.max(0, instruction.stroke.width),
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
        vertex: interactionMaskVertexShader,
      },
      resources: {
        interactionMaskUniforms: uniforms,
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

function createPlaceholderCanvas() {
  const canvas = document.createElement("canvas");

  canvas.height = 1;
  canvas.width = 1;

  return canvas;
}

const interactionMaskVertexShader = `#version 300 es
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

const interactionMaskFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform vec4 uFillPalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec4 uStrokePalette[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform float uStrokeWidths[${MAX_ID_MASK_PALETTE_ENTRIES}];
uniform vec2 uTextureSize;
uniform float uMaxStrokeWidth;

out vec4 finalColor;

float sampleMaskId(vec2 uv) {
  return floor(texture(uTexture, uv).r * 255.0 + 0.5);
}

int paletteIndex(float maskId) {
  return int(clamp(maskId, 0.0, float(${MAX_ID_MASK_PALETTE_ENTRIES - 1})));
}

vec4 readFill(float maskId) {
  return uFillPalette[paletteIndex(maskId)];
}

vec4 readStroke(float maskId) {
  return uStrokePalette[paletteIndex(maskId)];
}

float readStrokeWidth(float maskId) {
  return uStrokeWidths[paletteIndex(maskId)];
}

vec4 premultiplyAlpha(vec4 color) {
  return vec4(color.rgb * color.a, color.a);
}

bool differs(float left, float right) {
  return abs(left - right) > 0.5;
}

float findNeighborStrokeId(float centerId, vec2 texel) {
  float bestId = 0.0;

  for (int offsetY = -${MAX_INTERACTION_STROKE_RADIUS}; offsetY <= ${MAX_INTERACTION_STROKE_RADIUS}; offsetY += 1) {
    for (int offsetX = -${MAX_INTERACTION_STROKE_RADIUS}; offsetX <= ${MAX_INTERACTION_STROKE_RADIUS}; offsetX += 1) {
      if (offsetX == 0 && offsetY == 0) {
        continue;
      }

      float distance = max(abs(float(offsetX)), abs(float(offsetY)));

      if (distance > uMaxStrokeWidth) {
        continue;
      }

      float maskId = sampleMaskId(vUV + vec2(float(offsetX), float(offsetY)) * texel);

      if (maskId < 0.5 || !differs(maskId, centerId)) {
        continue;
      }

      if (readStrokeWidth(maskId) >= distance && readStroke(maskId).a > 0.0) {
        bestId = maskId;
      }
    }
  }

  return bestId;
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
