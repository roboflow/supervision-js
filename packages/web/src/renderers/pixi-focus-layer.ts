import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import { BaseFocusStyle } from "supervision-js-core";
import { BoxShape } from "supervision-js-core";
import type { FocusDrawInstruction, FocusStyle } from "supervision-js-core";
import type { DetectionPickResult } from "supervision-js-core";
import {
  centerRectToTopLeftRect,
  decodeCompressedRleMask,
  extractMaskRectRuns,
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

const MAX_FOCUS_MASK_IDS = 16;

type PixiFocusMesh = PixiMesh<PixiMeshGeometry, PixiShader>;

type GraphicsConstructor = new () => PixiFocusGraphics;
type ContainerConstructor = new () => PixiContainer;
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
}) => PixiFocusMesh;
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
    | { size?: number; type: "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

type PixiFocusGraphics = {
  visible: boolean;
  clear(): PixiFocusGraphics;
  cut(): unknown;
  fill(options: { readonly alpha: number; readonly color: number }): unknown;
  rect(x: number, y: number, width: number, height: number): PixiFocusGraphics;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): PixiFocusGraphics;
  poly?(points: number[], close?: boolean): PixiFocusGraphics;
};

export interface PixiFocusMaskArtifact {
  readonly frame: PreparedPngIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiFocusLayerFrameContext {
  readonly frame: FocusDrawFrame | undefined;
  readonly hoveredPick: DetectionPickResult | null;
  readonly idMaskArtifact?: PixiFocusMaskArtifact | null;
  readonly mediaTime: number;
  readonly selectedPick: DetectionPickResult | null;
  readonly viewportScale?: number;
}

type FocusDrawFrame = Parameters<FocusStyle["resolve"]>[0]["frame"];

export interface PixiFocusLayer {
  createDisplay(dimensions: {
    readonly width: number;
    readonly height: number;
  }): PixiContainer | PixiFocusGraphics;
  drawFrame(context: PixiFocusLayerFrameContext): void;
  tick(timestamp: number): void;
  setFocusStyle(focusStyle: FocusStyle | null | undefined): void;
  destroy(): void;
}

export function createPixiFocusLayer(options: {
  readonly Container?: ContainerConstructor;
  readonly Graphics: GraphicsConstructor;
  readonly ImageSource?: ImageSourceConstructor;
  readonly Mesh?: MeshConstructor;
  readonly MeshGeometry?: MeshGeometryConstructor;
  readonly Shader?: ShaderFactory;
  readonly UniformGroup?: UniformGroupConstructor;
  readonly focusStyle?: FocusStyle | null;
}): PixiFocusLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let focusStyle: FocusStyle | null =
    options.focusStyle === null
      ? null
      : (options.focusStyle ?? new BaseFocusStyle());
  let focusGraphics: PixiFocusGraphics | undefined;
  let idMaskRenderer: FocusIdMaskRenderer | undefined;
  let focusDisplay:
    | (PixiContainer & { alpha: number; visible: boolean })
    | (PixiFocusGraphics & { alpha: number })
    | undefined;
  let currentAlpha = 0;
  let targetAlpha = 0;
  let lastTick: number | null = null;
  let isDestroyed = false;

  return {
    createDisplay({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      focusGraphics = new options.Graphics();
      focusGraphics.visible = false;
      idMaskRenderer = createIdMaskRenderer();

      if (!options.Container || !idMaskRenderer) {
        focusDisplay = focusGraphics as PixiFocusGraphics & { alpha: number };
        focusDisplay.alpha = 0;
        return focusGraphics;
      }

      const container = new options.Container();

      container.addChild(idMaskRenderer.mesh, focusGraphics as never);
      focusDisplay = container as PixiContainer & {
        alpha: number;
        visible: boolean;
      };
      focusDisplay.alpha = 0;

      return container;
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      hide();
      idMaskRenderer?.destroy();
      idMaskRenderer = undefined;
    },

    drawFrame(context) {
      if (
        isDestroyed ||
        !focusStyle ||
        !context.frame ||
        mediaWidth <= 0 ||
        mediaHeight <= 0
      ) {
        hide();
        return;
      }

      const instruction = focusStyle.resolve({
        frame: context.frame,
        hoveredPick: context.hoveredPick,
        mediaTime: context.mediaTime,
        selectedPick: context.selectedPick,
        viewportScale: context.viewportScale,
      });

      if (!instruction || instruction.targets.length === 0) {
        transitionToHidden();
        return;
      }

      targetAlpha = 1;
      if (focusDisplay) focusDisplay.visible = true;

      if (drawIdMaskFocus(context.idMaskArtifact, instruction)) {
        hideVectorFocus();
        return;
      }

      idMaskRenderer?.hide();
      drawVectorFocus(instruction);
    },

    tick(timestamp) {
      if (!focusDisplay || currentAlpha === targetAlpha) {
        lastTick = timestamp;
        return;
      }
      const elapsed = Math.max(0, timestamp - (lastTick ?? timestamp));
      lastTick = timestamp;
      const progress = Math.min(1, elapsed / 120);
      const eased = 1 - (1 - progress) ** 3;
      currentAlpha += (targetAlpha - currentAlpha) * eased;
      if (Math.abs(targetAlpha - currentAlpha) < 0.001) {
        currentAlpha = targetAlpha;
      }
      focusDisplay.alpha = currentAlpha;
      if (currentAlpha === 0 && targetAlpha === 0) hide();
    },

    setFocusStyle(nextFocusStyle) {
      if (nextFocusStyle === undefined) {
        return;
      }

      focusStyle = nextFocusStyle;
    },
  };

  function drawIdMaskFocus(
    artifact: PixiFocusMaskArtifact | null | undefined,
    instruction: FocusDrawInstruction,
  ) {
    const maskIds = getTargetMaskIds(instruction.targets);

    if (
      !idMaskRenderer ||
      !artifact ||
      artifact.frame.kind !== PreparedMaskFrameKind.PngIdMask ||
      maskIds.length === 0 ||
      (!instruction.ambient && maskIds.length !== instruction.targets.length)
    ) {
      return false;
    }

    idMaskRenderer.render(
      artifact.frame,
      artifact.texture,
      maskIds,
      {
        alpha: instruction.fill.alpha,
        color: instruction.fill.color,
      },
      instruction.ambient === true,
    );

    return true;
  }

  function drawVectorFocus(instruction: FocusDrawInstruction) {
    if (!focusGraphics) {
      return;
    }

    const targetsWithRects = instruction.targets.filter(
      (target) =>
        target.detection.rect ||
        target.detection.polygon ||
        target.detection.mask,
    );

    if (targetsWithRects.length === 0) {
      hideVectorFocus();
      return;
    }

    focusGraphics.visible = true;
    focusGraphics.clear();
    focusGraphics.rect(0, 0, mediaWidth, mediaHeight);
    focusGraphics.fill(instruction.fill);

    for (const target of targetsWithRects) {
      drawCutout(target, instruction);
    }
  }

  function drawCutout(
    target: DetectionPickResult,
    instruction: FocusDrawInstruction,
  ) {
    if (!focusGraphics) {
      return;
    }

    if (target.detection.polygon?.points.length && focusGraphics.poly) {
      focusGraphics.poly(
        target.detection.polygon.points.flatMap(({ x, y }) => [x, y]),
        true,
      );
      focusGraphics.cut();
      return;
    }

    if (target.detection.mask) {
      const decoded = decodeCompressedRleMask(target.detection.mask);

      for (const run of extractMaskRectRuns(
        decoded.data,
        decoded.width,
        decoded.height,
      ) ?? []) {
        focusGraphics.rect(run.x, run.y, run.width, run.height);
        focusGraphics.cut();
      }

      return;
    }

    if (!target.detection.rect) {
      return;
    }

    const { rect } = target.detection;
    const fallback = instruction.fallback;
    const { x: left, y: top } = centerRectToTopLeftRect(rect);

    if (fallback?.shape === BoxShape.RoundedRect) {
      focusGraphics.roundRect(
        left,
        top,
        rect.width,
        rect.height,
        fallback.cornerRadius ?? 0,
      );
    } else {
      focusGraphics.rect(left, top, rect.width, rect.height);
    }

    focusGraphics.cut();
  }

  function hide() {
    hideVectorFocus();
    idMaskRenderer?.hide();
    if (focusDisplay) focusDisplay.visible = false;
  }

  function transitionToHidden() {
    targetAlpha = 0;
    if (currentAlpha === 0) hide();
  }

  function hideVectorFocus() {
    if (!focusGraphics) {
      return;
    }

    focusGraphics.clear();
    focusGraphics.visible = false;
  }

  function createIdMaskRenderer() {
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

    return createFocusIdMaskRenderer({
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

function getTargetMaskIds(targets: readonly DetectionPickResult[]) {
  return targets
    .filter((target) => target.detection.mask)
    .slice(0, MAX_FOCUS_MASK_IDS)
    .map((target) => target.detectionIndex + 1);
}

interface FocusIdMaskRenderer {
  readonly mesh: PixiFocusMesh;
  hide(): void;
  render(
    frame: PreparedPngIdMaskFrame,
    texture: PixiTexture,
    maskIds: readonly number[],
    fill: { readonly alpha: number; readonly color: number },
    ambient: boolean,
  ): void;
  destroy(): void;
}

function createFocusIdMaskRenderer(options: {
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh: MeshConstructor;
  readonly MeshGeometry: MeshGeometryConstructor;
  readonly Shader: ShaderFactory;
  readonly UniformGroup: UniformGroupConstructor;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
}): FocusIdMaskRenderer {
  const selectedIds = new Float32Array(MAX_FOCUS_MASK_IDS);
  const uniforms = new options.UniformGroup({
    uOverlayColor: {
      type: "vec4<f32>",
      value: new Float32Array([0, 0, 0, 0]),
    },
    uSelectedCount: { type: "f32", value: 0 },
    uSelectedIds: {
      size: MAX_FOCUS_MASK_IDS,
      type: "f32",
      value: selectedIds,
    },
    uAmbient: { type: "f32", value: 0 },
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

    render(_frame, texture, maskIds, fill, ambient) {
      bindTexture(texture.source);
      selectedIds.fill(0);

      for (
        let index = 0;
        index < maskIds.length && index < MAX_FOCUS_MASK_IDS;
        index += 1
      ) {
        selectedIds[index] = maskIds[index] ?? 0;
      }

      uniforms.uniforms.uSelectedCount = Math.min(
        maskIds.length,
        MAX_FOCUS_MASK_IDS,
      );
      uniforms.uniforms.uSelectedIds = selectedIds;
      uniforms.uniforms.uOverlayColor = createPremultipliedColor(fill);
      uniforms.uniforms.uAmbient = ambient ? 1 : 0;
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
        fragment: focusIdMaskFragmentShader,
        vertex: focusIdMaskVertexShader,
      },
      resources: {
        focusUniforms: uniforms,
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

function createPremultipliedColor(fill: {
  readonly alpha: number;
  readonly color: number;
}) {
  const alpha = Math.max(0, Math.min(fill.alpha, 1));

  return new Float32Array([
    (((fill.color >> 16) & 0xff) / 255) * alpha,
    (((fill.color >> 8) & 0xff) / 255) * alpha,
    ((fill.color & 0xff) / 255) * alpha,
    alpha,
  ]);
}

function createPlaceholderCanvas() {
  const canvas = document.createElement("canvas");

  canvas.height = 1;
  canvas.width = 1;

  return canvas;
}

const focusIdMaskVertexShader = `#version 300 es
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

const focusIdMaskFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;
uniform float uSelectedIds[${MAX_FOCUS_MASK_IDS}];
uniform float uSelectedCount;
uniform float uAmbient;
uniform vec4 uOverlayColor;

out vec4 finalColor;

float sampleMaskId(vec2 uv) {
  return floor(texture(uTexture, uv).r * 255.0 + 0.5);
}

bool isFocusedMask(float maskId) {
  if (maskId < 0.5) {
    return false;
  }

  if (uAmbient > 0.5) {
    return true;
  }

  for (int index = 0; index < ${MAX_FOCUS_MASK_IDS}; index += 1) {
    if (float(index) >= uSelectedCount) {
      break;
    }

    if (abs(uSelectedIds[index] - maskId) < 0.5) {
      return true;
    }
  }

  return false;
}

void main(void) {
  if (isFocusedMask(sampleMaskId(vUV))) {
    finalColor = vec4(0.0);
    return;
  }

  finalColor = uOverlayColor * vColor;
}
`;
