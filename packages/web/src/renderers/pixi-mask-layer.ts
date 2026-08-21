import {
  pickDetectionByMaskId,
  pickDetectionAtPoint as pickDetectionAtPointCpu,
} from "supervision-js-core";
import {
  createPreparedRenderWindow,
  PreparedRenderFrameMaskStatus,
  type PreparedMaskFrame,
  type PreparedRenderTimelineContext,
} from "#render-preparation/prepared-render-window";
import {
  PreparedMaskFrameKind,
  type PreparedPngIdMaskFrame,
  type PreparedRegionMaskCoverageEntry,
  type PreparedRegionMaskCoverageFrame,
  type PreparedRgbaMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type {
  DetectionPickPoint,
  DetectionPickResult,
} from "supervision-js-core";
import type { MaskHaloStyle, MaskStyle } from "supervision-js-core";
import type {
  RenderPreparationOptions,
  RenderPreparationArtifactKind,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import { resolveMaskStyleOpacity } from "supervision-js-core";
import { createPixiIdMaskShaderRenderer } from "./pixi-id-mask-shader";
import {
  buildMaskHaloPalette,
  createPixiMaskHaloRenderer,
} from "./pixi-mask-halo";
import type { MaskHaloPassGroup, PixiMaskHaloRenderer } from "./pixi-mask-halo";
import type {
  Container as PixiContainer,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
  Sprite as PixiSprite,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

const MAX_PENDING_MASK_HOLD_SECONDS = 0.05;

type ImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement | ImageBitmap;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiImageSource;

type TextureConstructor = new (options: {
  dynamic: boolean;
  source: PixiImageSource;
}) => PixiTexture;
type TextureConstructorWithEmpty = TextureConstructor & {
  readonly EMPTY: PixiTexture;
};

type SpriteConstructor = new (options?: {
  texture?: PixiTexture;
}) => PixiSprite;

type ContainerConstructor = new () => PixiContainer;

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

type UniformGroupConstructor = new (
  uniforms: Record<
    string,
    | { type: "f32"; value: number }
    | { size?: number; type: "f32"; value: Float32Array }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

export interface PixiMaskLayer {
  createSprite(dimensions: {
    width: number;
    height: number;
  }): PixiContainer | PixiSprite;
  drawFrame(mediaTime: number): void;
  waitForRenderPreparation(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): Promise<void>;
  pickDetectionAtPoint(
    point: DetectionPickPoint,
    mediaTime: number,
  ): DetectionPickResult | null;
  getActiveIdMaskFrameTexture(): PixiActiveIdMaskFrameTexture | null;
  getActiveRegionMaskCoverage(): PixiActiveRegionMaskCoverage | null;
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  setMaskHaloStyle(maskHaloStyle: MaskHaloStyle | null | undefined): void;
  destroy(): void;
}

export interface PixiActiveIdMaskFrameTexture {
  readonly frame: PreparedPngIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiActiveRegionMaskCoverage {
  readonly frame: PreparedRegionMaskCoverageFrame;
  getTexture(entry: PreparedRegionMaskCoverageEntry): PixiTexture | undefined;
}

export function createPixiMaskLayer(options: {
  readonly artifactKind?: RenderPreparationArtifactKind;
  readonly Container?: ContainerConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh?: MeshConstructor;
  readonly MeshGeometry?: MeshGeometryConstructor;
  readonly Shader?: ShaderFactory;
  readonly Sprite: SpriteConstructor;
  readonly Texture: TextureConstructorWithEmpty;
  readonly UniformGroup?: UniformGroupConstructor;
  readonly Rectangle?: new (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => unknown;
  readonly BlurFilter?: new (options: {
    strength: number;
    quality?: number;
  }) => { strength: number };
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskHaloStyle?: MaskHaloStyle | null;
  readonly maskStyle: MaskStyle;
  readonly onActiveIdMaskFramePresented?: () => void;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly resolveInstructions?: (options: {
    readonly frame: import("supervision-js-core").DetectionFrame;
    readonly maskStyle: MaskStyle;
    readonly mediaTime: number;
  }) => readonly SerializableMaskInstruction[];
}): PixiMaskLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let idMaskRenderer:
    ReturnType<typeof createPixiIdMaskShaderRenderer> | undefined;
  let haloRenderer: PixiMaskHaloRenderer | undefined;
  let currentMaskHaloStyle: MaskHaloStyle | null =
    options.maskHaloStyle ?? null;
  let currentMaskStyle: MaskStyle = options.maskStyle;
  let maskSprite: PixiSprite | undefined;
  let activeFrameKey: string | null = null;
  let activeFrameMediaTime: number | null = null;
  let activeRegionMaskFrameKey: string | null = null;
  let activeIdMaskFrame: PreparedPngIdMaskFrame | null = null;
  let activeRgbaMaskFrame: PreparedRgbaMaskFrame | null = null;
  let maskOpacity = resolveMaskStyleOpacity(options.maskStyle);
  let maskPickCanvas: HTMLCanvasElement | undefined;
  let maskPickContext: CanvasRenderingContext2D | null | undefined;
  let maskPickFrameKey: string | null = null;
  let visibleMaskMediaTime: number | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const haloTextures = new Map<string, PixiTexture>();
  const regionMaskTextures = new Map<string, Map<number, PixiTexture>>();
  const preparedRenderWindow = createPreparedRenderWindow({
    artifactKind: options.artifactKind,
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);
      if (key === maskPickFrameKey) {
        resetMaskPickCanvas();
      }
      if (key === activeFrameKey) {
        activeFrameKey = null;
        activeFrameMediaTime = null;
        hideSprite();
      }
    },
    onMaskFramePrepared(maskFrame) {
      if (!isDestroyed && maskFrame.key === activeFrameKey) {
        showMaskFrame(maskFrame, activeFrameMediaTime);
        if (
          (maskFrame.kind === PreparedMaskFrameKind.PngIdMask ||
            maskFrame.regionMaskCoverage) &&
          activeFrameMediaTime !== null
        ) {
          options.onActiveIdMaskFramePresented?.();
        }
      }
    },
    onMaskFramesCleared() {
      activeFrameKey = null;
      activeFrameMediaTime = null;
      resetMaskPickCanvas();
      destroyTextures();
      hideSprite();
    },
    renderPreparation: options.renderPreparation,
    resolveInstructions: options.resolveInstructions,
  });

  return {
    createSprite({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      maskSprite = new options.Sprite();
      maskSprite.alpha = maskOpacity;
      maskSprite.visible = false;
      maskSprite.width = mediaWidth;
      maskSprite.height = mediaHeight;

      idMaskRenderer = createIdMaskRenderer();
      idMaskRenderer?.setOpacity(maskOpacity);
      haloRenderer = createHaloRenderer();
      // Halo alpha is resolved from MaskHaloStyle per detection. It must not
      // inherit the independent mask renderer's global opacity.
      haloRenderer?.setOpacity(1);

      if (!idMaskRenderer || !options.Container) {
        return maskSprite;
      }

      const maskContainer = new options.Container();

      // The halo draws beneath the mask so the glow bleeds outward from the
      // silhouette while fills and borders stay crisp on top.
      if (haloRenderer) {
        maskContainer.addChild(haloRenderer.display);
      }

      maskContainer.addChild(maskSprite, idMaskRenderer.mesh);

      return maskContainer;
    },

    drawFrame(mediaTime) {
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

      if (!preparedFrame || !maskSprite) {
        activeFrameKey = preparedFrame?.key ?? null;
        activeFrameMediaTime = preparedFrame?.detectionFrame.mediaTime ?? null;
        activeIdMaskFrame = null;
        activeRgbaMaskFrame = null;
        hideSprite();
        return;
      }

      activeFrameKey = preparedFrame.key;
      activeFrameMediaTime = preparedFrame.detectionFrame.mediaTime;

      if (preparedFrame.maskFrame) {
        showMaskFrame(
          preparedFrame.maskFrame,
          preparedFrame.detectionFrame.mediaTime,
        );
        return;
      }

      if (
        preparedFrame.maskStatus === PreparedRenderFrameMaskStatus.Empty ||
        preparedFrame.maskStatus === PreparedRenderFrameMaskStatus.Disabled
      ) {
        activeIdMaskFrame = null;
        activeRgbaMaskFrame = null;
        hideSprite();
        return;
      }

      activeIdMaskFrame = null;

      if (!canHoldVisibleMaskFor(preparedFrame.detectionFrame.mediaTime)) {
        hideSprite();
      }
    },

    waitForRenderPreparation(mediaTime, gateOptions) {
      return preparedRenderWindow.waitForReady(mediaTime, gateOptions);
    },

    pickDetectionAtPoint(point, mediaTime) {
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);
      const maskFrame = preparedFrame?.maskFrame;

      if (!preparedFrame || !maskFrame) {
        return null;
      }

      if (maskFrame.kind !== PreparedMaskFrameKind.PngIdMask) {
        return pickDetectionAtPointCpu(preparedFrame.detectionFrame, point, {
          filter: (detection) => detection.mask !== undefined,
          maskMediaDimensions: { height: mediaHeight, width: mediaWidth },
        });
      }

      if (mediaWidth <= 0 || mediaHeight <= 0) {
        return null;
      }

      const x = Math.floor((point.x / mediaWidth) * maskFrame.width);
      const y = Math.floor((point.y / mediaHeight) * maskFrame.height);

      if (x < 0 || y < 0 || x >= maskFrame.width || y >= maskFrame.height) {
        return null;
      }

      const maskId = readMaskId(maskFrame, x, y);

      return pickDetectionByMaskId(preparedFrame.detectionFrame, maskId, point);
    },

    getActiveIdMaskFrameTexture() {
      if (!activeIdMaskFrame) {
        return null;
      }

      return {
        frame: activeIdMaskFrame,
        texture: getTexture(activeIdMaskFrame),
      };
    },

    getActiveRegionMaskCoverage() {
      if (activeRegionMaskFrameKey !== activeFrameKey) return null;
      const coverage =
        activeIdMaskFrame?.regionMaskCoverage ??
        activeRgbaMaskFrame?.regionMaskCoverage;

      if (!coverage) return null;

      return {
        frame: coverage,
        getTexture: (entry) => getRegionMaskTexture(activeFrameKey!, entry),
      };
    },

    setTimelineContext(context) {
      preparedRenderWindow.setTimelineContext(context);
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle !== undefined) {
        currentMaskStyle = nextMaskStyle ?? currentMaskStyle;
        maskOpacity = resolveMaskStyleOpacity(nextMaskStyle);
        applyMaskOpacity();
      }

      preparedRenderWindow.setMaskStyle(nextMaskStyle);
      refreshHalo();
    },

    setMaskHaloStyle(nextMaskHaloStyle) {
      if (nextMaskHaloStyle === undefined) {
        return;
      }

      currentMaskHaloStyle = nextMaskHaloStyle;
      refreshHalo();
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      preparedRenderWindow.destroy();
      destroyTextures();
      resetMaskPickCanvas();
      idMaskRenderer?.destroy();
      haloRenderer?.destroy();
    },
  };

  function showMaskFrame(
    maskFrame: PreparedMaskFrame,
    mediaTime: number | null,
  ) {
    visibleMaskMediaTime = mediaTime;
    activeRegionMaskFrameKey = maskFrame.key;
    activeIdMaskFrame =
      maskFrame.kind === PreparedMaskFrameKind.PngIdMask ? maskFrame : null;
    activeRgbaMaskFrame =
      maskFrame.kind === PreparedMaskFrameKind.RgbaImage ? maskFrame : null;

    if (maskFrame.kind === PreparedMaskFrameKind.PngIdMask && idMaskRenderer) {
      showIdMaskFrame(maskFrame);
      return;
    }

    if (maskFrame.kind === PreparedMaskFrameKind.RgbaImage) {
      showRgbaMaskFrame(maskFrame);
    }
  }

  function getTexture(maskFrame: PreparedMaskFrame) {
    const existingTexture = maskTextures.get(maskFrame.key);

    if (existingTexture) {
      return existingTexture;
    }

    const imageSource = new options.ImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      height: maskFrame.height,
      resource: maskFrame.source,
      scaleMode:
        maskFrame.kind === PreparedMaskFrameKind.PngIdMask
          ? "nearest"
          : "linear",
      width: maskFrame.width,
    });
    const texture = new options.Texture({
      dynamic: false,
      source: imageSource,
    });

    maskTextures.set(maskFrame.key, texture);

    return texture;
  }

  function getHaloTexture(maskFrame: PreparedRgbaMaskFrame) {
    const existingTexture = haloTextures.get(maskFrame.key);

    if (existingTexture) {
      return existingTexture;
    }

    if (!maskFrame.idMaskData || typeof document === "undefined") {
      return undefined;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context || typeof context.createImageData !== "function") {
      return undefined;
    }

    canvas.width = maskFrame.width;
    canvas.height = maskFrame.height;
    const imageData = context.createImageData(
      maskFrame.width,
      maskFrame.height,
    );

    for (let index = 0; index < maskFrame.idMaskData.length; index += 1) {
      const offset = index * 4;
      imageData.data[offset] = maskFrame.idMaskData[index]!;
      imageData.data[offset + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
    const source = new options.ImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      height: maskFrame.height,
      resource: canvas,
      scaleMode: "nearest",
      width: maskFrame.width,
    });
    const texture = new options.Texture({ dynamic: false, source });

    haloTextures.set(maskFrame.key, texture);

    return texture;
  }

  function getRegionMaskTexture(
    frameKey: string,
    entry: PreparedRegionMaskCoverageEntry,
  ) {
    const textures = regionMaskTextures.get(frameKey) ?? new Map();
    const existingTexture = textures.get(entry.detectionIndex);
    if (existingTexture) return existingTexture;

    if (typeof document === "undefined") return undefined;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    canvas.width = entry.width;
    canvas.height = entry.height;
    const rgba = new Uint8ClampedArray(
      new ArrayBuffer(entry.width * entry.height * 4),
    );
    for (let index = 0; index < entry.data.length; index += 1) {
      const offset = index * 4;
      rgba[offset] = entry.data[index]!;
      rgba[offset + 3] = 255;
    }
    context.putImageData(new ImageData(rgba, entry.width, entry.height), 0, 0);
    const source = new options.ImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      height: entry.height,
      resource: canvas,
      scaleMode: "nearest",
      width: entry.width,
    });
    const texture = new options.Texture({ dynamic: false, source });

    textures.set(entry.detectionIndex, texture);
    regionMaskTextures.set(frameKey, textures);
    return texture;
  }

  function showRgbaMaskFrame(maskFrame: PreparedRgbaMaskFrame) {
    if (!maskSprite) {
      return;
    }

    const texture = getTexture(maskFrame);

    maskSprite.texture = texture;
    applyMaskOpacity();
    maskSprite.width = mediaWidth;
    maskSprite.height = mediaHeight;
    maskSprite.visible = true;
    idMaskRenderer?.hide();
    const haloTexture = getHaloTexture(maskFrame);

    if (haloTexture) {
      renderHalo(maskFrame, haloTexture);
    } else {
      haloRenderer?.hide();
    }
  }

  function showIdMaskFrame(
    maskFrame: Extract<
      PreparedMaskFrame,
      { readonly kind: PreparedMaskFrameKind.PngIdMask }
    >,
  ) {
    if (!idMaskRenderer || !maskSprite) {
      return;
    }

    maskSprite.visible = false;
    idMaskRenderer.render(maskFrame, getTexture(maskFrame));
    renderHalo(maskFrame, getTexture(maskFrame));
  }

  function renderHalo(
    maskFrame: { readonly height: number; readonly width: number },
    texture: PixiTexture,
  ) {
    if (!haloRenderer) {
      return;
    }

    const groups = resolveFrameHaloGroups();

    if (groups.length === 0) {
      haloRenderer.hide();
      return;
    }

    haloRenderer.render(maskFrame, texture, groups);
  }

  function refreshHalo() {
    if (activeIdMaskFrame) {
      renderHalo(activeIdMaskFrame, getTexture(activeIdMaskFrame));
      return;
    }

    if (activeRgbaMaskFrame) {
      const texture = getHaloTexture(activeRgbaMaskFrame);

      if (texture) {
        renderHalo(activeRgbaMaskFrame, texture);
      }
    }
  }

  /**
   * Halo instructions resolve per frame from the live halo style rather than
   * being baked into the prepared artifact, so halo edits never invalidate
   * prepared mask pixels. Detections are grouped by their requested spread
   * and every group renders in its own blur pass, preserving each
   * detection's public spread contract.
   */
  function resolveFrameHaloGroups(): readonly MaskHaloPassGroup[] {
    if (visibleMaskMediaTime === null || !currentMaskHaloStyle) {
      return [];
    }

    const frame = options.detectionTimeline.selectFrame(visibleMaskMediaTime);

    if (!frame) {
      return [];
    }

    const bySpread = new Map<
      number,
      Map<number, { readonly alpha: number; readonly color: number }>
    >();

    for (const [detectionIndex, detection] of frame.detections.entries()) {
      if (!detection.mask) {
        continue;
      }

      const halo = currentMaskHaloStyle.resolve(detection, {
        detectionIndex,
        frame,
        mediaTime: visibleMaskMediaTime,
      });

      if (!halo || halo.alpha <= 0 || halo.spread <= 0) {
        continue;
      }

      let group = bySpread.get(halo.spread);

      if (!group) {
        group = new Map();
        bySpread.set(halo.spread, group);
      }

      group.set(detectionIndex + 1, { alpha: halo.alpha, color: halo.color });
    }

    return [...bySpread.entries()]
      .sort(([left], [right]) => left - right)
      .map(([spread, halos]) => ({
        palette: buildMaskHaloPalette(halos),
        spread,
      }));
  }

  function hideSprite() {
    visibleMaskMediaTime = null;
    activeIdMaskFrame = null;
    activeRgbaMaskFrame = null;
    activeRegionMaskFrameKey = null;

    if (maskSprite) {
      maskSprite.visible = false;
    }

    idMaskRenderer?.hide();
    haloRenderer?.hide();
  }

  function canHoldVisibleMaskFor(mediaTime: number) {
    return (
      visibleMaskMediaTime !== null &&
      Math.abs(mediaTime - visibleMaskMediaTime) <=
        MAX_PENDING_MASK_HOLD_SECONDS
    );
  }

  function applyMaskOpacity() {
    if (maskSprite) {
      maskSprite.alpha = maskOpacity;
    }

    idMaskRenderer?.setOpacity(maskOpacity);
  }

  function destroyTexture(key: string) {
    const texture = maskTextures.get(key);

    if (!texture) {
      destroyHaloTexture(key);
      destroyRegionMaskTextures(key);
      return;
    }

    releaseTextureBindings(key, texture);
    maskTextures.delete(key);
    texture.destroy(true);
    destroyHaloTexture(key);
    destroyRegionMaskTextures(key);
  }

  function destroyHaloTexture(key: string) {
    const texture = haloTextures.get(key);

    if (!texture) {
      return;
    }

    haloTextures.delete(key);
    texture.destroy(true);
  }

  function destroyRegionMaskTextures(key: string) {
    const textures = regionMaskTextures.get(key);
    if (!textures) return;
    regionMaskTextures.delete(key);
    for (const texture of textures.values()) texture.destroy(true);
  }

  function destroyTextures() {
    releaseTextureBindings();

    for (const texture of maskTextures.values()) {
      texture.destroy(true);
    }

    maskTextures.clear();

    for (const texture of haloTextures.values()) {
      texture.destroy(true);
    }

    haloTextures.clear();

    for (const textures of regionMaskTextures.values()) {
      for (const texture of textures.values()) texture.destroy(true);
    }

    regionMaskTextures.clear();
  }

  function releaseTextureBindings(key?: string, texture?: PixiTexture) {
    if (!texture || maskSprite?.texture === texture) {
      if (maskSprite) {
        maskSprite.texture = options.Texture.EMPTY;
      }
    }

    if (!key || activeFrameKey === key) {
      idMaskRenderer?.clearTexture();
    }
  }

  function createHaloRenderer() {
    if (
      !options.BlurFilter ||
      !options.Container ||
      !options.Rectangle ||
      !options.Mesh ||
      !options.MeshGeometry ||
      !options.Shader ||
      !options.UniformGroup ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return undefined;
    }

    return createPixiMaskHaloRenderer({
      BlurFilter: options.BlurFilter,
      Container: options.Container,
      Rectangle: options.Rectangle,
      ImageSource: options.ImageSource,
      Mesh: options.Mesh,
      MeshGeometry: options.MeshGeometry,
      Shader: options.Shader,
      UniformGroup: options.UniformGroup,
      mediaHeight,
      mediaWidth,
    });
  }

  function createIdMaskRenderer() {
    if (
      !options.Mesh ||
      !options.MeshGeometry ||
      !options.Shader ||
      !options.UniformGroup
    ) {
      return undefined;
    }

    try {
      return createPixiIdMaskShaderRenderer({
        ImageSource: options.ImageSource,
        Mesh: options.Mesh,
        MeshGeometry: options.MeshGeometry,
        Shader: options.Shader,
        UniformGroup: options.UniformGroup,
        mediaHeight,
        mediaWidth,
      });
    } catch {
      return undefined;
    }
  }

  function readMaskId(
    maskFrame: Extract<
      PreparedMaskFrame,
      { readonly kind: PreparedMaskFrameKind.PngIdMask }
    >,
    x: number,
    y: number,
  ) {
    try {
      const context = getMaskPickContext(maskFrame);

      if (!context) {
        return 0;
      }

      return context.getImageData(x, y, 1, 1).data[0] ?? 0;
    } catch {
      resetMaskPickCanvas();
      return 0;
    }
  }

  function getMaskPickContext(
    maskFrame: Extract<
      PreparedMaskFrame,
      { readonly kind: PreparedMaskFrameKind.PngIdMask }
    >,
  ) {
    if (typeof document === "undefined") {
      return null;
    }

    if (!maskPickCanvas) {
      maskPickCanvas = document.createElement("canvas");
      maskPickContext = maskPickCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    }

    if (!maskPickContext) {
      return null;
    }

    if (
      maskPickFrameKey !== maskFrame.key ||
      maskPickCanvas.width !== maskFrame.width ||
      maskPickCanvas.height !== maskFrame.height
    ) {
      maskPickCanvas.width = maskFrame.width;
      maskPickCanvas.height = maskFrame.height;
      maskPickContext.clearRect(0, 0, maskFrame.width, maskFrame.height);
      maskPickContext.drawImage(maskFrame.source, 0, 0);
      maskPickFrameKey = maskFrame.key;
    }

    return maskPickContext;
  }

  function resetMaskPickCanvas() {
    maskPickFrameKey = null;

    if (maskPickCanvas) {
      maskPickCanvas.width = 0;
      maskPickCanvas.height = 0;
    }
  }
}
