import { tintedMaskVertexWgsl } from "#renderers/mask-vertex-wgsl";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { PreparedIdMaskFrame } from "#render-preparation/mask-frame-artifact";
import { BaseFocusStyle } from "supervision-js-core";
import { BoxShape } from "supervision-js-core";
import type { FocusDrawInstruction, FocusStyle } from "supervision-js-core";
import type { DetectionPickResult } from "supervision-js-core";
import { centerRectToTopLeftRect } from "supervision-js-core";
import {
  decodeCompressedRleMask,
  extractMaskRectRuns,
} from "supervision-js-core";
import type { MaskRectRun } from "supervision-js-core";
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
/**
 * How far the media may travel before a cutout drawn for an earlier frame stops
 * covering what it cut out. Detections in a 30fps handheld clip move a sixth of
 * their own size across two frames, and a hole that far off its subject reads as
 * a hole in the wrong place.
 */
const HELD_CUTOUT_SECONDS = 0.05;
/**
 * How long the dim overlay survives frames that arrive with nothing to cut. It
 * covers a mask cook running behind (872ms at its worst under a six-times CPU
 * throttle) and then gives up through the fade, never through a cut.
 */
const HELD_OVERLAY_MS = 1000;

type PixiFocusMesh = PixiMesh<PixiMeshGeometry, PixiShader>;
type FocusFill = FocusDrawInstruction["fill"];
type CutoutShapeResult = "drawn" | "empty";
type MaskCutoutCacheEntry = {
  readonly height: number;
  readonly runs: readonly MaskRectRun[];
  readonly width: number;
} | null;

/**
 * What the vector cutout geometry is built from. Detections are immutable
 * snapshots, so identity is enough to tell one frame's targets from another's.
 */
interface VectorFocusSignature {
  readonly cornerRadius: number | undefined;
  readonly detections: readonly object[];
  readonly fillAlpha: number;
  readonly fillColor: number;
  readonly frame: object;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
  readonly shape: BoxShape | undefined;
}

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
    | { size?: number; type: "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

type PixiFocusGraphics = {
  visible: boolean;
  clear(): PixiFocusGraphics;
  cut(): unknown;
  fill(options: { readonly alpha: number; readonly color: number }): unknown;
  setMask?: PixiContainer["setMask"];
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
  readonly frame: PreparedIdMaskFrame;
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
  readonly isDetectionVisible?: (
    detection: DetectionPickResult["detection"],
  ) => boolean;
}): PixiFocusLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let focusStyle: FocusStyle | null =
    options.focusStyle === null
      ? null
      : (options.focusStyle ?? new BaseFocusStyle());
  let focusGraphics: PixiFocusGraphics | undefined;
  let focusMaskGraphics: PixiFocusGraphics | undefined;
  let idMaskRenderer: FocusIdMaskRenderer | undefined;
  let focusDisplay:
    | (PixiContainer & { alpha: number; visible: boolean })
    | (PixiFocusGraphics & { alpha: number })
    | undefined;
  let currentAlpha = 0;
  let targetAlpha = 0;
  let lastTick: number | null = null;
  let isDestroyed = false;
  let hasIdMaskShaderFailed = false;
  let vectorFocusSignature: VectorFocusSignature | null = null;
  let heldFill: FocusFill | null = null;
  let cutoutMediaTime: number | null = null;
  let drawnOverlayWithoutCutout: FocusFill | null = null;
  let isHoldingOverlay = false;
  let holdStartedAtMs: number | null = null;
  // A frame can fall back to a composited RGBA texture when its colored ID-mask
  // palette is exhausted. Keep decoded row runs by the immutable mask payload so
  // that fallback focus still cuts out the actual mask, not its bounding rect.
  const maskCutoutRuns = new WeakMap<object, MaskCutoutCacheEntry>();

  return {
    createDisplay({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      resetHeldFocus();
      focusGraphics = new options.Graphics();
      focusGraphics.visible = false;
      idMaskRenderer = createIdMaskRenderer();

      if (!options.Container || !focusGraphics.setMask) {
        focusDisplay = focusGraphics as PixiFocusGraphics & { alpha: number };
        focusDisplay.alpha = 0;
        return focusGraphics;
      }

      const container = new options.Container();
      focusMaskGraphics = new options.Graphics();
      focusGraphics.setMask({
        inverse: true,
        mask: focusMaskGraphics as unknown as PixiContainer,
      });

      if (idMaskRenderer) {
        container.addChild(idMaskRenderer.mesh);
      }
      container.addChild(focusGraphics as never, focusMaskGraphics as never);
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
      if (isDestroyed || !focusStyle || mediaWidth <= 0 || mediaHeight <= 0) {
        hide();
        return;
      }

      if (!context.frame) {
        holdOverlay(context.mediaTime);
        return;
      }

      const resolvedInstruction = focusStyle.resolve({
        frame: context.frame,
        hoveredPick: context.hoveredPick,
        mediaTime: context.mediaTime,
        selectedPick: context.selectedPick,
        viewportScale: context.viewportScale,
      });
      // Ambient focus targets every detection in the frame, so a class the
      // caller has hidden would otherwise be cut out of the overlay.
      const instruction = resolvedInstruction
        ? {
            ...resolvedInstruction,
            targets: resolvedInstruction.targets.filter(
              ({ detection }) =>
                options.isDetectionVisible?.(detection) ?? true,
            ),
          }
        : undefined;

      endHold();

      if (!instruction || instruction.targets.length === 0) {
        resetHeldFocus();
        transitionToHidden();
        return;
      }

      heldFill = instruction.fill;
      targetAlpha = 1;
      if (focusDisplay) focusDisplay.visible = true;

      if (drawIdMaskFocus(context.idMaskArtifact, instruction)) {
        hideVectorFocus();
        markCutoutDrawn(context.mediaTime);
        return;
      }

      idMaskRenderer?.hide();

      if (drawVectorFocus(instruction, context.frame)) {
        markCutoutDrawn(context.mediaTime);
      }
    },

    tick(timestamp) {
      expireHold(timestamp);

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
    if (
      !idMaskRenderer ||
      !artifact ||
      artifact.frame.kind !== PreparedMaskFrameKind.IdMask
    ) {
      return false;
    }

    const maskIds = getTargetMaskIds(instruction.targets);

    if (
      maskIds.length === 0 ||
      (!instruction.ambient && maskIds.length !== instruction.targets.length)
    ) {
      return false;
    }

    idMaskRenderer.render(
      artifact.frame,
      artifact.texture,
      maskIds,
      instruction.fill,
      instruction.ambient === true,
    );

    return true;
  }

  function drawVectorFocus(
    instruction: FocusDrawInstruction,
    frame: FocusDrawFrame,
  ) {
    if (!focusGraphics) {
      return false;
    }

    const targetsWithGeometry = instruction.targets.filter(
      (target) =>
        target.detection.mask ||
        target.detection.rect ||
        target.detection.polygon,
    );

    if (targetsWithGeometry.length === 0) {
      drawOverlayWithoutCutout(instruction.fill);
      return false;
    }

    const signature: VectorFocusSignature = {
      cornerRadius: instruction.fallback?.cornerRadius,
      detections: targetsWithGeometry.map((target) => target.detection),
      fillAlpha: instruction.fill.alpha,
      fillColor: instruction.fill.color,
      frame,
      mediaHeight,
      mediaWidth,
      shape: instruction.fallback?.shape,
    };

    focusGraphics.visible = true;
    if (focusMaskGraphics) focusMaskGraphics.visible = true;

    // Tessellating thousands of mask runs on every draw is what makes this path
    // expensive, and nothing it draws moves while its inputs hold still.
    if (isSameVectorFocus(vectorFocusSignature, signature)) {
      return true;
    }

    vectorFocusSignature = signature;
    focusGraphics.clear();
    focusGraphics.rect(0, 0, mediaWidth, mediaHeight);
    focusGraphics.fill(instruction.fill);

    if (focusMaskGraphics) {
      focusMaskGraphics.clear();

      for (const target of targetsWithGeometry) {
        if (
          drawCutoutShape(focusMaskGraphics, target, instruction) === "drawn"
        ) {
          focusMaskGraphics.fill({ alpha: 1, color: 0xffffff });
        }
      }
      return true;
    }

    for (const target of targetsWithGeometry) {
      if (drawCutoutShape(focusGraphics, target, instruction) === "drawn") {
        focusGraphics.cut();
      }
    }

    return true;
  }

  function drawCutoutShape(
    graphics: PixiFocusGraphics,
    target: DetectionPickResult,
    instruction: FocusDrawInstruction,
  ): CutoutShapeResult {
    const maskCutout = drawMaskCutout(graphics, target);

    if (maskCutout) {
      return maskCutout;
    }

    if (target.detection.polygon?.points.length && graphics.poly) {
      graphics.poly(
        target.detection.polygon.points.flatMap(({ x, y }) => [x, y]),
        true,
      );
      return "drawn";
    }

    if (!target.detection.rect) {
      return "empty";
    }

    const { rect } = target.detection;
    const fallback = instruction.fallback;
    const { x: left, y: top } = centerRectToTopLeftRect(rect);

    if (fallback?.shape === BoxShape.RoundedRect) {
      graphics.roundRect(
        left,
        top,
        rect.width,
        rect.height,
        fallback.cornerRadius ?? 0,
      );
    } else {
      graphics.rect(left, top, rect.width, rect.height);
    }

    return "drawn";
  }

  function drawMaskCutout(
    graphics: PixiFocusGraphics,
    target: DetectionPickResult,
  ): CutoutShapeResult | undefined {
    const mask = target.detection.mask;

    if (!mask) {
      return undefined;
    }

    let runs: MaskCutoutCacheEntry;

    if (!maskCutoutRuns.has(mask)) {
      try {
        const decoded = decodeCompressedRleMask(mask);
        runs = {
          height: decoded.height,
          runs:
            extractMaskRectRuns(decoded.data, decoded.width, decoded.height) ??
            [],
          width: decoded.width,
        };
      } catch {
        // Preserve the documented rectangle fallback for malformed masks. A
        // valid mask must never lose its shape merely because ID-mask rendering
        // is unavailable, but an unreadable payload still has only bounds.
        runs = null;
      }

      maskCutoutRuns.set(mask, runs);
    } else {
      runs = maskCutoutRuns.get(mask)!;
    }

    if (runs === null) {
      return undefined;
    }

    const horizontalScale = mediaWidth / runs.width;
    const verticalScale = mediaHeight / runs.height;

    for (const run of runs.runs) {
      graphics.rect(
        run.x * horizontalScale,
        run.y * verticalScale,
        run.width * horizontalScale,
        run.height * verticalScale,
      );
    }

    return runs.runs.length === 0 ? "empty" : "drawn";
  }

  function hide() {
    resetHeldFocus();
    hideVectorFocus();
    idMaskRenderer?.hide();
    if (focusDisplay) focusDisplay.visible = false;
  }

  function transitionToHidden() {
    targetAlpha = 0;
    if (currentAlpha === 0) hide();
  }

  /**
   * Keeps the dim overlay on screen for a frame the cutout cannot be drawn for.
   * Everything dimmed for a moment reads as a pause; the picture flashing to
   * full brightness and back reads as a fault.
   */
  function holdOverlay(mediaTime: number) {
    if (!heldFill) {
      transitionToHidden();
      return;
    }

    isHoldingOverlay = true;
    targetAlpha = 1;
    if (focusDisplay) focusDisplay.visible = true;

    if (
      cutoutMediaTime !== null &&
      Math.abs(mediaTime - cutoutMediaTime) <= HELD_CUTOUT_SECONDS &&
      isDrawnCutoutIntact()
    ) {
      return;
    }

    drawOverlayWithoutCutout(heldFill);
  }

  function endHold() {
    isHoldingOverlay = false;
    holdStartedAtMs = null;
  }

  function expireHold(timestamp: number) {
    if (!isHoldingOverlay) {
      return;
    }

    holdStartedAtMs ??= timestamp;

    if (timestamp - holdStartedAtMs > HELD_OVERLAY_MS) {
      endHold();
      transitionToHidden();
    }
  }

  function markCutoutDrawn(mediaTime: number) {
    cutoutMediaTime = mediaTime;
    drawnOverlayWithoutCutout = null;
  }

  function resetHeldFocus() {
    cutoutMediaTime = null;
    drawnOverlayWithoutCutout = null;
    heldFill = null;
    vectorFocusSignature = null;
    endHold();
  }

  /**
   * A cutout drawn from an ID mask lives in a texture the mask cook owns and
   * evicts, so what is on screen can outlive the pixels behind it. Vector
   * cutouts are this layer's own geometry and outlive nothing.
   */
  function isDrawnCutoutIntact() {
    return (
      idMaskRenderer?.isDrawnFrameIntact() === true ||
      focusGraphics?.visible === true
    );
  }

  function drawOverlayWithoutCutout(fill: FocusFill) {
    if (
      drawnOverlayWithoutCutout?.alpha === fill.alpha &&
      drawnOverlayWithoutCutout.color === fill.color
    ) {
      return;
    }

    cutoutMediaTime = null;
    drawnOverlayWithoutCutout = fill;

    if (idMaskRenderer) {
      hideVectorFocus();
      idMaskRenderer.renderWithoutCutout(fill);
      return;
    }

    if (!focusGraphics) {
      return;
    }

    vectorFocusSignature = null;
    focusGraphics.visible = true;
    focusGraphics.clear();
    focusGraphics.rect(0, 0, mediaWidth, mediaHeight);
    focusGraphics.fill(fill);

    if (focusMaskGraphics) {
      focusMaskGraphics.visible = true;
      focusMaskGraphics.clear();
    }
  }

  function hideVectorFocus() {
    if (!focusGraphics) {
      return;
    }

    vectorFocusSignature = null;
    focusGraphics.clear();
    focusGraphics.visible = false;
    focusMaskGraphics?.clear();
    if (focusMaskGraphics) focusMaskGraphics.visible = false;
  }

  function createIdMaskRenderer() {
    if (
      hasIdMaskShaderFailed ||
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

    try {
      return createFocusIdMaskRenderer({
        ImageSource: options.ImageSource,
        Mesh: options.Mesh,
        MeshGeometry: options.MeshGeometry,
        Shader: options.Shader,
        UniformGroup: options.UniformGroup,
        mediaHeight,
        mediaWidth,
      });
    } catch {
      hasIdMaskShaderFailed = true;
      return undefined;
    }
  }
}

function isSameVectorFocus(
  previous: VectorFocusSignature | null,
  next: VectorFocusSignature,
) {
  return (
    previous !== null &&
    previous.frame === next.frame &&
    previous.fillAlpha === next.fillAlpha &&
    previous.fillColor === next.fillColor &&
    previous.cornerRadius === next.cornerRadius &&
    previous.shape === next.shape &&
    previous.mediaHeight === next.mediaHeight &&
    previous.mediaWidth === next.mediaWidth &&
    previous.detections.length === next.detections.length &&
    previous.detections.every(
      (detection, index) => detection === next.detections[index],
    )
  );
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
  /** Whether what the mesh last drew still has its ID raster behind it. */
  isDrawnFrameIntact(): boolean;
  render(
    frame: PreparedIdMaskFrame,
    texture: PixiTexture,
    maskIds: readonly number[],
    fill: FocusFill,
    ambient: boolean,
  ): void;
  renderWithoutCutout(fill: FocusFill): void;
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
  // uSelectedIds is read back as vec4 lanes, which WGSL only allows at a 16-byte
  // aligned offset, so it has to stay the first entry of this group.
  const uniforms = new options.UniformGroup({
    uSelectedIds: {
      size: MAX_FOCUS_MASK_IDS,
      type: "f32",
      value: selectedIds,
    },
    uOverlayColor: {
      type: "vec4<f32>",
      value: new Float32Array([0, 0, 0, 0]),
    },
    uSelectedCount: { type: "f32", value: 0 },
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
  const overlayColor = new Float32Array(4);
  let boundSource: PixiImageSource | undefined;
  let drawnAmbient: number | null = null;
  let drawnCount = -1;
  let drawnFillAlpha = Number.NaN;
  let drawnFillColor = Number.NaN;

  mesh.visible = false;

  return {
    destroy() {
      mesh.destroy();
      shader.destroy();
      geometry.destroy();
      placeholderSource.destroy();
    },

    hide() {
      mesh.visible = false;
    },

    isDrawnFrameIntact() {
      return (
        mesh.visible &&
        boundSource !== undefined &&
        boundSource !== placeholderSource &&
        !boundSource.destroyed
      );
    },

    mesh,

    render(_frame, texture, maskIds, fill, ambient) {
      let hasNewIds = false;
      let count = 0;

      // Ambient focus keeps every ID the raster carries, so the shader reads
      // neither the list nor its length, and a count that tracked the detections
      // would dirty the uniform buffer on every frame they changed.
      if (!ambient) {
        count = Math.min(maskIds.length, MAX_FOCUS_MASK_IDS);

        for (let index = 0; index < MAX_FOCUS_MASK_IDS; index += 1) {
          const maskId = index < count ? (maskIds[index] ?? 0) : 0;

          if (selectedIds[index] !== maskId) {
            selectedIds[index] = maskId;
            hasNewIds = true;
          }
        }
      }

      bindTexture(texture.source);
      applyUniforms(count, ambient ? 1 : 0, fill, hasNewIds);
      mesh.visible = true;
    },

    renderWithoutCutout(fill) {
      // The placeholder raster reads back as ID zero everywhere, which is the
      // one value the shader never treats as focused.
      bindTexture(placeholderSource);
      applyUniforms(0, 0, fill, false);
      mesh.visible = true;
    },
  };

  function applyUniforms(
    count: number,
    ambient: number,
    fill: FocusFill,
    hasNewIds: boolean,
  ) {
    if (
      !hasNewIds &&
      count === drawnCount &&
      ambient === drawnAmbient &&
      fill.alpha === drawnFillAlpha &&
      fill.color === drawnFillColor
    ) {
      return;
    }

    drawnAmbient = ambient;
    drawnCount = count;
    drawnFillAlpha = fill.alpha;
    drawnFillColor = fill.color;
    writePremultipliedColor(overlayColor, fill);
    uniforms.uniforms.uSelectedCount = count;
    uniforms.uniforms.uSelectedIds = selectedIds;
    uniforms.uniforms.uOverlayColor = overlayColor;
    uniforms.uniforms.uAmbient = ambient;
    uniforms.update();
  }

  function bindTexture(source: PixiImageSource) {
    if (source === boundSource) {
      return;
    }

    boundSource = source;

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
      gpu: {
        fragment: {
          entryPoint: "mainFragment",
          source: focusIdMaskFragmentWgsl,
        },
        vertex: {
          entryPoint: "mainVertex",
          source: tintedMaskVertexWgsl,
        },
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

function writePremultipliedColor(target: Float32Array, fill: FocusFill) {
  const alpha = Math.max(0, Math.min(fill.alpha, 1));

  target[0] = (((fill.color >> 16) & 0xff) / 255) * alpha;
  target[1] = (((fill.color >> 8) & 0xff) / 255) * alpha;
  target[2] = ((fill.color & 0xff) / 255) * alpha;
  target[3] = alpha;
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

// A WGSL uniform array needs a 16-byte element stride, while Pixi uploads an f32
// uniform array tightly packed, so the ids are read back as vec4 lanes. That only
// lines up while the id count stays a multiple of four.
const FOCUS_MASK_ID_LANES = MAX_FOCUS_MASK_IDS / 4;

const focusIdMaskFragmentWgsl = `
struct FocusUniforms {
  uSelectedIds: array<vec4<f32>, ${FOCUS_MASK_ID_LANES}>,
  uOverlayColor: vec4<f32>,
  uSelectedCount: f32,
  uAmbient: f32,
}

@group(2) @binding(0) var<uniform> focusUniforms: FocusUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

fn sampleMaskId(uv: vec2<f32>) -> f32 {
  return floor(textureSampleLevel(uTexture, uSampler, uv, 0.0).r * 255.0 + 0.5);
}

fn readSelectedId(index: i32) -> f32 {
  return focusUniforms.uSelectedIds[index / 4][index % 4];
}

fn isFocusedMask(maskId: f32) -> bool {
  if (maskId < 0.5) {
    return false;
  }

  if (focusUniforms.uAmbient > 0.5) {
    return true;
  }

  for (var index = 0; index < ${MAX_FOCUS_MASK_IDS}; index += 1) {
    if (f32(index) >= focusUniforms.uSelectedCount) {
      break;
    }

    if (abs(readSelectedId(index) - maskId) < 0.5) {
      return true;
    }
  }

  return false;
}

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  if (isFocusedMask(sampleMaskId(vUV))) {
    return vec4<f32>(0.0);
  }

  return focusUniforms.uOverlayColor * vColor;
}
`;
