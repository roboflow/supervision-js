import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import { BaseFocusStyle } from "#styles/focus-style";
import { BoxShape } from "#types/box-style";
import type { FocusDrawInstruction, FocusStyle } from "#types/focus-style";
import type { DetectionPickResult } from "#types/interaction";
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
}

type FocusDrawFrame = Parameters<FocusStyle["resolve"]>[0]["frame"];

export interface PixiFocusLayer {
  createDisplay(dimensions: {
    readonly width: number;
    readonly height: number;
  }): PixiContainer | PixiFocusGraphics;
  drawFrame(context: PixiFocusLayerFrameContext): void;
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
  let isDestroyed = false;

  return {
    createDisplay({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      focusGraphics = new options.Graphics();
      focusGraphics.visible = false;
      idMaskRenderer = createIdMaskRenderer();

      if (!options.Container || !idMaskRenderer) {
        return focusGraphics;
      }

      const container = new options.Container();

      container.addChild(idMaskRenderer.mesh, focusGraphics as never);

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
      });

      if (!instruction || instruction.targets.length === 0) {
        hide();
        return;
      }

      if (drawIdMaskFocus(context.idMaskArtifact, instruction)) {
        hideVectorFocus();
        return;
      }

      idMaskRenderer?.hide();
      drawVectorFocus(instruction);
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
      maskIds.length !== instruction.targets.length
    ) {
      return false;
    }

    idMaskRenderer.render(artifact.frame, artifact.texture, maskIds, {
      alpha: instruction.fill.alpha,
      color: instruction.fill.color,
    });

    return true;
  }

  function drawVectorFocus(instruction: FocusDrawInstruction) {
    if (!focusGraphics) {
      return;
    }

    const targetsWithRects = instruction.targets.filter(
      (target) => target.detection.rect,
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
    if (!focusGraphics || !target.detection.rect) {
      return;
    }

    const { rect } = target.detection;
    const fallback = instruction.fallback;

    if (fallback?.shape === BoxShape.RoundedRect) {
      focusGraphics.roundRect(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        fallback.cornerRadius ?? 0,
      );
    } else {
      focusGraphics.rect(rect.x, rect.y, rect.width, rect.height);
    }

    focusGraphics.cut();
  }

  function hide() {
    hideVectorFocus();
    idMaskRenderer?.hide();
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

    render(_frame, texture, maskIds, fill) {
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
uniform vec4 uOverlayColor;

out vec4 finalColor;

float sampleMaskId(vec2 uv) {
  return floor(texture(uTexture, uv).r * 255.0 + 0.5);
}

bool isFocusedMask(float maskId) {
  if (maskId < 0.5) {
    return false;
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
