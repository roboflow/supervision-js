import { resolveDisplayPixelRatio } from "#media/display-pixel-ratio";
import {
  pickDetectionByMaskId,
  pickDetectionAtPoint as pickDetectionAtPointCpu,
} from "supervision-js-core";
import {
  createPreparedRenderWindow,
  PreparedRenderFrameMaskStatus,
  type PreparedMaskFrame,
  type PreparedRenderFrame,
  type PreparedRenderTimelineContext,
} from "#render-preparation/prepared-render-window";
import {
  IdMaskTextureFormat,
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
  type PreparedIdMaskFrame,
  type PreparedRegionMaskCoverageEntry,
  type PreparedRegionMaskCoverageFrame,
  type PreparedRgbaMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import { getBufferedDetectionTimelineFrameSnapshot } from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionFrame,
} from "supervision-js-core";
import type {
  DetectionPickPoint,
  DetectionPickResult,
} from "supervision-js-core";
import type { MaskHaloStyle, MaskStyle } from "supervision-js-core";
import { RenderPreparationArtifactKind } from "#types/render-preparation";
import type {
  RenderPreparationMaskFrameOptions,
  RenderPreparationOptions,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "#renderers/injected-pixi";
import type { PresentedFrameId } from "./presented-frame-channel";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import { resolveMaskStyleOpacity } from "supervision-js-core";
import { createPixiIdMaskShaderRenderer } from "./pixi-id-mask-shader";
import {
  buildMaskHaloPalette,
  createPixiMaskHaloRenderer,
  resolvePaintedMaskHalo,
} from "./pixi-mask-halo";
import type { MaskHaloPassGroup, PixiMaskHaloRenderer } from "./pixi-mask-halo";
import type {
  BufferImageSource as PixiBufferImageSource,
  Container as PixiContainer,
  ImageSource as PixiImageSource,
  Mesh as PixiMesh,
  Sprite as PixiSprite,
  Texture as PixiTexture,
  UniformGroup as PixiUniformGroup,
} from "pixi.js";

const TEXTURE_ROW_ALIGNMENT_BYTES = 4;

type ImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  height: number;
  resource: HTMLCanvasElement | ImageBitmap;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiImageSource;

export type BufferImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  format: IdMaskTextureFormat;
  height: number;
  resource: Uint8Array;
  scaleMode?: "linear" | "nearest";
  width: number;
}) => PixiBufferImageSource;

type TextureConstructor = new (options: {
  dynamic: boolean;
  source: PixiImageSource | PixiBufferImageSource;
}) => PixiTexture;
type TextureConstructorWithEmpty = TextureConstructor & {
  readonly EMPTY: PixiTexture;
};

type SpriteConstructor = new (options?: {
  texture?: PixiTexture;
}) => PixiSprite;

type ContainerConstructor = new () => PixiContainer;

type UniformGroupConstructor = new (
  uniforms: Record<
    string,
    | { type: "f32"; value: number }
    | { size?: number; type: "f32"; value: Float32Array }
    | { size?: number; type: "vec2<f32>" | "vec4<f32>"; value: Float32Array }
  >,
) => PixiUniformGroup;

/**
 * What the mask layer has on screen after its last draw.
 *
 * `drawnFrameTime` is the detection frame the visible raster belongs to. It is
 * the frame the rest of the present drew, or the frame beside it while that
 * frame's own cook is owed, or the layer draws nothing.
 * `drawnFrameId` names the producer frame that raster was accepted for, and is
 * null on a draw the producer did not drive: a pull-path sample and a redraw at
 * a resting playhead both carry a media time and no frame identity.
 */
export interface PixiMaskLayerState {
  readonly drawnFrameTime: number | null;
  readonly drawnFrameKey: string | null;
  readonly drawnFrameId: PresentedFrameId | null;
}

export interface PixiMaskLayer {
  createSprite(dimensions: {
    width: number;
    height: number;
  }): PixiContainer | PixiSprite;
  drawFrame(
    mediaTime: number,
    presentedFrameId?: PresentedFrameId | null,
  ): void;
  /** The state the last drawFrame or clearFrame left on screen. */
  getDrawnState(): PixiMaskLayerState;
  /** Puts the media time in front of the cook without drawing it. */
  prepareFrame(mediaTime: number): void;
  clearFrame(): void;
  isArtifactPrepared(mediaTime: number): boolean;
  waitForRenderPreparation(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): Promise<void>;
  pickDetectionAtPoint(
    point: DetectionPickPoint,
    mediaTime: number,
  ): DetectionPickResult | null;
  /**
   * The raster on screen, for a caller drawing the same detection frame it
   * belongs to. Both of these are read by layers that pair the raster to
   * detections by position, so a raster from any other frame pairs one frame's
   * silhouettes to another frame's detections.
   */
  getActiveIdMaskFrameTexture(
    detectionFrameTime: number | null,
  ): PixiActiveIdMaskFrameTexture | null;
  getActiveRegionMaskCoverage(
    detectionFrameTime: number | null,
  ): PixiActiveRegionMaskCoverage | null;
  setPlaybackActive(active: boolean): void;
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  setMaskHaloStyle(maskHaloStyle: MaskHaloStyle | null | undefined): void;
  /**
   * Whether the mask fill reaches the screen. Preparation runs either way, so
   * consumers of the id raster still get an artifact while the fill is off.
   */
  setFillVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * Cook-only style for consumers that read detection ids out of the raster
 * instead of drawing the fill. Ids come from the detection index, so the colour
 * and alpha here never reach the screen.
 */
export const ID_MASK_PREPARATION_STYLE: MaskStyle = {
  artifactKey: "id-mask-preparation",
  resolve: (detection) =>
    detection.mask
      ? { alpha: 1, color: 0xffffff, mask: detection.mask }
      : undefined,
};

export type IdMaskDisplayBox = NonNullable<
  RenderPreparationMaskFrameOptions["display"]
>;

export interface PixiActiveIdMaskFrameTexture {
  readonly frame: PreparedIdMaskFrame;
  readonly texture: PixiTexture;
}

export interface PixiActiveRegionMaskCoverage {
  readonly frame: PreparedRegionMaskCoverageFrame;
  getTexture(entry: PreparedRegionMaskCoverageEntry): PixiTexture | undefined;
}

export function createPixiMaskLayer(options: {
  readonly artifactKind?: RenderPreparationArtifactKind;
  readonly BufferImageSource?: BufferImageSourceConstructor;
  readonly Container?: ContainerConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh?: InjectedMeshConstructor<PixiMesh>;
  readonly MeshGeometry?: InjectedMeshGeometryConstructor;
  readonly Shader?: InjectedShaderFactory;
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
  readonly onPreparedWindowChange?: () => void;
  /**
   * Whether the renderer takes a single-channel upload whose rows are not on a
   * four-byte boundary. Answered when the first raster is uploaded, since the
   * renderer this scene ends up with is not known when the layer is built.
   */
  readonly acceptsUnalignedTextureRows?: () => boolean;
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
  let maskSprite: PixiSprite | undefined;
  let visibleMaskFrameKey: string | null = null;
  let activeIdMaskFrame: PreparedIdMaskFrame | null = null;
  let activeRgbaMaskFrame: PreparedRgbaMaskFrame | null = null;
  let maskOpacity = resolveMaskStyleOpacity(options.maskStyle);
  let isFillVisible = true;
  let visibleMaskMediaTime: number | null = null;
  let visibleMaskFrameId: PresentedFrameId | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const haloTextures = new Map<string, PixiTexture>();
  const regionMaskTextures = new Map<string, Map<number, PixiTexture>>();
  const maskFrameOptions = options.renderPreparation?.maskFrame;
  const preparedRenderWindow = createPreparedRenderWindow({
    artifactKind: options.artifactKind,
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);

      if (key === visibleMaskFrameKey) {
        hideSprite();
      }
    },
    onPreparedWindowChange() {
      if (!isDestroyed) {
        options.onPreparedWindowChange?.();
      }
    },
    onMaskFramesCleared() {
      destroyTextures();
      hideSprite();
    },
    renderPreparation: options.renderPreparation,
    resolveInstructions: options.resolveInstructions,
    resolveMaxRasterWidth,
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

    drawFrame(mediaTime, presentedFrameId = null) {
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

      if (preparedFrame?.maskFrame) {
        showMaskFrame(
          preparedFrame.maskFrame,
          preparedFrame.detectionFrame.mediaTime,
          presentedFrameId,
        );
        return;
      }

      if (!preparedFrame || !canHoldVisibleMaskOver(preparedFrame)) {
        hideSprite();
      }
    },

    getDrawnState() {
      return {
        drawnFrameTime: visibleMaskMediaTime,
        drawnFrameKey: visibleMaskFrameKey,
        drawnFrameId: visibleMaskFrameId,
      };
    },

    prepareFrame(mediaTime) {
      preparedRenderWindow.getFrame(mediaTime);
    },

    clearFrame() {
      hideSprite();
    },

    isArtifactPrepared(mediaTime) {
      return preparedRenderWindow.isArtifactPrepared(mediaTime);
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

      if (maskFrame.kind !== PreparedMaskFrameKind.IdMask) {
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

      return pickDetectionByMaskId(
        preparedFrame.detectionFrame,
        readIdMaskRasterValue(maskFrame, x, y),
        point,
      );
    },

    getActiveIdMaskFrameTexture(detectionFrameTime) {
      if (!activeIdMaskFrame || detectionFrameTime !== visibleMaskMediaTime) {
        return null;
      }

      const texture = getTexture(activeIdMaskFrame);

      return texture ? { frame: activeIdMaskFrame, texture } : null;
    },

    getActiveRegionMaskCoverage(detectionFrameTime) {
      const coverage =
        activeIdMaskFrame?.regionMaskCoverage ??
        activeRgbaMaskFrame?.regionMaskCoverage;

      if (
        !coverage ||
        !visibleMaskFrameKey ||
        detectionFrameTime !== visibleMaskMediaTime
      ) {
        return null;
      }

      const frameKey = visibleMaskFrameKey;

      return {
        frame: coverage,
        getTexture: (entry) => getRegionMaskTexture(frameKey, entry),
      };
    },

    setPlaybackActive(active) {
      preparedRenderWindow.setPlaybackActive(active);
    },

    setTimelineContext(context) {
      preparedRenderWindow.setTimelineContext(context);
    },

    setMaskStyle(nextMaskStyle) {
      if (nextMaskStyle !== undefined) {
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

    setFillVisible(visible) {
      isFillVisible = visible;

      if (!visible) {
        hideFill();
      }
    },

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      preparedRenderWindow.destroy();
      destroyTextures();
      idMaskRenderer?.destroy();
      haloRenderer?.destroy();
    },
  };

  function showMaskFrame(
    maskFrame: PreparedMaskFrame,
    mediaTime: number,
    presentedFrameId: PresentedFrameId | null,
  ) {
    visibleMaskMediaTime = mediaTime;
    visibleMaskFrameKey = maskFrame.key;
    visibleMaskFrameId = presentedFrameId;
    activeIdMaskFrame =
      maskFrame.kind === PreparedMaskFrameKind.IdMask ? maskFrame : null;
    activeRgbaMaskFrame =
      maskFrame.kind === PreparedMaskFrameKind.RgbaImage ? maskFrame : null;

    // A halo-only presentation turns the fill off and still draws a glow.
    refreshHalo();

    if (!isFillVisible) {
      hideFill();
      return;
    }

    if (maskFrame.kind === PreparedMaskFrameKind.IdMask && idMaskRenderer) {
      showIdMaskFrame(maskFrame);
      return;
    }

    showRgbaMaskFrame(maskFrame);
  }

  function getTexture(maskFrame: PreparedMaskFrame) {
    const existingTexture = maskTextures.get(maskFrame.key);

    if (existingTexture) {
      return existingTexture;
    }

    const source = createTextureSource(maskFrame);

    if (!source) {
      return undefined;
    }

    const texture = new options.Texture({ dynamic: false, source });

    maskTextures.set(maskFrame.key, texture);

    return texture;
  }

  /**
   * The widest raster the picture can show. Polygon frames rasterize geometry
   * at a size of their own choosing, so this sizes mask frames only.
   */
  function resolveMaxRasterWidth() {
    const display = maskFrameOptions?.display;
    const artifactKind =
      options.artifactKind ?? RenderPreparationArtifactKind.MaskFrame;

    if (
      !display ||
      artifactKind !== RenderPreparationArtifactKind.MaskFrame ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return undefined;
    }

    const fit = Math.min(
      display.boxWidth / mediaWidth,
      display.boxHeight / mediaHeight,
    );
    const pixelRatio = resolveDisplayPixelRatio(display);

    return fit > 0 && pixelRatio > 0
      ? alignRasterWidth(Math.ceil(mediaWidth * fit * pixelRatio))
      : undefined;
  }

  /**
   * An unaligned single-channel upload is paid for in four channels, so a width
   * off the boundary costs four times the raster.
   */
  function alignRasterWidth(rasterWidth: number) {
    if (options.acceptsUnalignedTextureRows?.() === true) {
      return rasterWidth;
    }

    return Math.max(
      TEXTURE_ROW_ALIGNMENT_BYTES,
      Math.floor(rasterWidth / TEXTURE_ROW_ALIGNMENT_BYTES) *
        TEXTURE_ROW_ALIGNMENT_BYTES,
    );
  }

  function createTextureSource(maskFrame: PreparedMaskFrame) {
    if (maskFrame.kind !== PreparedMaskFrameKind.IdMask) {
      return new options.ImageSource({
        autoGenerateMipmaps: false,
        dynamic: false,
        height: maskFrame.height,
        resource: maskFrame.source,
        scaleMode: "linear",
        width: maskFrame.width,
      });
    }

    const BufferImageSource = options.BufferImageSource;

    if (!BufferImageSource) {
      return undefined;
    }

    const needsFourChannels =
      maskFrame.width % TEXTURE_ROW_ALIGNMENT_BYTES !== 0 &&
      options.acceptsUnalignedTextureRows?.() !== true;

    return new BufferImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      format: needsFourChannels
        ? IdMaskTextureFormat.Rgba8
        : IdMaskTextureFormat.R8,
      height: maskFrame.height,
      resource: needsFourChannels
        ? expandIdsToRgba(maskFrame.raster)
        : maskFrame.raster,
      scaleMode: "nearest",
      width: maskFrame.width,
    });
  }

  function showRgbaMaskFrame(maskFrame: PreparedMaskFrame) {
    const texture = getTexture(maskFrame);

    if (!maskSprite || !texture) {
      return;
    }

    maskSprite.texture = texture;
    applyMaskOpacity();
    maskSprite.width = mediaWidth;
    maskSprite.height = mediaHeight;
    maskSprite.visible = true;
    idMaskRenderer?.hide();
  }

  function showIdMaskFrame(
    maskFrame: Extract<
      PreparedMaskFrame,
      { readonly kind: PreparedMaskFrameKind.IdMask }
    >,
  ) {
    const texture = getTexture(maskFrame);

    if (!idMaskRenderer || !maskSprite || !texture) {
      return;
    }

    maskSprite.visible = false;
    idMaskRenderer.render(maskFrame, texture);
  }

  function hideFill() {
    if (maskSprite) {
      maskSprite.visible = false;
    }

    idMaskRenderer?.hide();
  }

  /**
   * Whether the raster on screen may stand over a frame whose own cook has not
   * landed, which it may for exactly the frame beside its own.
   *
   * The bound is counted in frames of the timeline and never in seconds. A span
   * of seconds only means one frame at one frame rate and one playback rate, so
   * it has to be scaled by the rate to go on meaning it, and that scaling is
   * what once left a raster twelve frames old on the picture after a fast run.
   */
  function canHoldVisibleMaskOver(preparedFrame: PreparedRenderFrame) {
    return (
      preparedFrame.maskStatus === PreparedRenderFrameMaskStatus.Pending &&
      visibleMaskMediaTime !== null &&
      isNeighbouringDetectionFrame(
        visibleMaskMediaTime,
        preparedFrame.detectionFrame.mediaTime,
      )
    );
  }

  function isNeighbouringDetectionFrame(
    mediaTime: number,
    otherMediaTime: number,
  ) {
    const frames = getBufferedDetectionTimelineFrameSnapshot(
      options.detectionTimeline,
    );
    const index = indexOfDetectionFrameAt(frames, mediaTime);
    const otherIndex = indexOfDetectionFrameAt(frames, otherMediaTime);

    return (
      index !== -1 && otherIndex !== -1 && Math.abs(index - otherIndex) === 1
    );
  }

  /**
   * Everything the layer hands other layers is a view of the raster on screen,
   * so a draw that puts none up has to drop them all in the same step.
   */
  function hideSprite() {
    visibleMaskMediaTime = null;
    visibleMaskFrameKey = null;
    visibleMaskFrameId = null;
    activeIdMaskFrame = null;
    activeRgbaMaskFrame = null;
    hideFill();
    haloRenderer?.hide();
  }

  function applyMaskOpacity() {
    if (maskSprite) {
      maskSprite.alpha = maskOpacity;
    }

    idMaskRenderer?.setOpacity(maskOpacity);
  }

  function destroyTexture(key: string) {
    destroyHaloTexture(key);
    destroyRegionMaskTextures(key);

    const texture = maskTextures.get(key);

    if (!texture) {
      return;
    }

    releaseTextureBindings(key, texture);
    maskTextures.delete(key);
    texture.destroy(true);
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

    if (!textures) {
      return;
    }

    regionMaskTextures.delete(key);

    for (const texture of textures.values()) {
      texture.destroy(true);
    }
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
      for (const texture of textures.values()) {
        texture.destroy(true);
      }
    }

    regionMaskTextures.clear();
  }

  function releaseTextureBindings(key?: string, texture?: PixiTexture) {
    if (!texture || maskSprite?.texture === texture) {
      if (maskSprite) {
        maskSprite.texture = options.Texture.EMPTY;
      }
    }

    if (!key || visibleMaskFrameKey === key) {
      idMaskRenderer?.clearTexture();
    }
  }

  /**
   * The halo reads detection ids out of the red channel, which the id raster
   * already carries. Where preparation degraded to the RGBA composite the ids
   * ride along uncomposited, so they still need a texture built for them. The
   * halo mesh spans the media rect and samples this over 0..1, so the plane's
   * own capped size is what the texture is built at, not the composite's.
   */
  function getHaloTexture(maskFrame: PreparedRgbaMaskFrame) {
    const existingTexture = haloTextures.get(maskFrame.key);

    if (existingTexture) {
      return existingTexture;
    }

    const idMaskPlane = maskFrame.idMaskPlane;

    if (!idMaskPlane || typeof document === "undefined") {
      return undefined;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context || typeof context.createImageData !== "function") {
      return undefined;
    }

    canvas.width = idMaskPlane.width;
    canvas.height = idMaskPlane.height;

    const imageData = context.createImageData(
      idMaskPlane.width,
      idMaskPlane.height,
    );

    for (let index = 0; index < idMaskPlane.data.length; index += 1) {
      const offset = index * 4;

      imageData.data[offset] = idMaskPlane.data[index]!;
      imageData.data[offset + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);

    const texture = new options.Texture({
      dynamic: false,
      source: new options.ImageSource({
        autoGenerateMipmaps: false,
        dynamic: false,
        height: idMaskPlane.height,
        resource: canvas,
        scaleMode: "nearest",
        width: idMaskPlane.width,
      }),
    });

    haloTextures.set(maskFrame.key, texture);

    return texture;
  }

  function getRegionMaskTexture(
    frameKey: string,
    entry: PreparedRegionMaskCoverageEntry,
  ) {
    const textures = regionMaskTextures.get(frameKey) ?? new Map();
    const existingTexture = textures.get(entry.detectionIndex);

    if (existingTexture) {
      return existingTexture;
    }

    if (typeof document === "undefined") {
      return undefined;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      return undefined;
    }

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

    const texture = new options.Texture({
      dynamic: false,
      source: new options.ImageSource({
        autoGenerateMipmaps: false,
        dynamic: false,
        height: entry.height,
        resource: canvas,
        scaleMode: "nearest",
        width: entry.width,
      }),
    });

    textures.set(entry.detectionIndex, texture);
    regionMaskTextures.set(frameKey, textures);

    return texture;
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
      const texture = getTexture(activeIdMaskFrame);

      if (texture) {
        renderHalo(activeIdMaskFrame, texture);
      }

      return;
    }

    if (activeRgbaMaskFrame) {
      const texture = getHaloTexture(activeRgbaMaskFrame);

      if (texture) {
        renderHalo(activeRgbaMaskFrame, texture);
        return;
      }
    }

    haloRenderer?.hide();
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
      const halo = resolvePaintedMaskHalo(currentMaskHaloStyle, detection, {
        detectionIndex,
        frame,
        mediaTime: visibleMaskMediaTime,
      });

      if (!halo) {
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
      ImageSource: options.ImageSource,
      Mesh: options.Mesh,
      MeshGeometry: options.MeshGeometry,
      Rectangle: options.Rectangle,
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
}

/**
 * Ids in the red channel of four, for a renderer that will not take them one
 * byte per pixel. Four times the memory and a full pass over the raster, so it
 * runs only where the single-channel upload would be rejected.
 */
function expandIdsToRgba(ids: Uint8Array): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8Array(new ArrayBuffer(ids.length * 4));

  for (let index = 0; index < ids.length; index += 1) {
    rgba[index * 4] = ids[index] ?? 0;
    rgba[index * 4 + 3] = 0xff;
  }

  return rgba;
}

/** Where the frame sits in the timeline's buffer, which is held in media-time
 *  order, or -1 for a time no frame of detections sits on. */
function indexOfDetectionFrameAt(
  frames: readonly DetectionFrame[],
  mediaTime: number,
) {
  let low = 0;
  let high = frames.length - 1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const frameTime = frames[middle].mediaTime;

    if (frameTime === mediaTime) {
      return middle;
    }

    if (frameTime < mediaTime) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return -1;
}
