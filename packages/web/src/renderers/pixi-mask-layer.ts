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
  IdMaskRasterFormat,
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
  type PreparedIdMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type {
  DetectionPickPoint,
  DetectionPickResult,
} from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import type {
  RenderPreparationOptions,
  RenderPreparationArtifactKind,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import { resolveMaskStyleOpacity } from "supervision-js-core";
import { createPixiIdMaskShaderRenderer } from "./pixi-id-mask-shader";
import type {
  BufferImageSource as PixiBufferImageSource,
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

export type BufferImageSourceConstructor = new (options: {
  autoGenerateMipmaps?: boolean;
  dynamic: boolean;
  format: IdMaskRasterFormat;
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
  getActiveIdMaskFrameTexture(): PixiActiveIdMaskFrameTexture | null;
  setPlaybackActive(active: boolean): void;
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
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

export interface PixiActiveIdMaskFrameTexture {
  readonly frame: PreparedIdMaskFrame;
  readonly texture: PixiTexture;
}

export function createPixiMaskLayer(options: {
  readonly artifactKind?: RenderPreparationArtifactKind;
  readonly BufferImageSource?: BufferImageSourceConstructor;
  readonly Container?: ContainerConstructor;
  readonly ImageSource: ImageSourceConstructor;
  readonly Mesh?: MeshConstructor;
  readonly MeshGeometry?: MeshGeometryConstructor;
  readonly Shader?: ShaderFactory;
  readonly Sprite: SpriteConstructor;
  readonly Texture: TextureConstructorWithEmpty;
  readonly UniformGroup?: UniformGroupConstructor;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly maskStyle: MaskStyle;
  readonly onPreparedWindowChange?: () => void;
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
  let maskSprite: PixiSprite | undefined;
  let activeFrameKey: string | null = null;
  let activeIdMaskFrame: PreparedIdMaskFrame | null = null;
  let maskOpacity = resolveMaskStyleOpacity(options.maskStyle);
  let isFillVisible = true;
  let visibleMaskMediaTime: number | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const preparedRenderWindow = createPreparedRenderWindow({
    artifactKind: options.artifactKind,
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);
      if (key === activeFrameKey) {
        activeFrameKey = null;
        hideSprite();
      }
    },
    onPreparedWindowChange() {
      if (!isDestroyed) {
        options.onPreparedWindowChange?.();
      }
    },
    onMaskFramesCleared() {
      activeFrameKey = null;
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

      if (!idMaskRenderer || !options.Container) {
        return maskSprite;
      }

      const maskContainer = new options.Container();
      maskContainer.addChild(maskSprite, idMaskRenderer.mesh);

      return maskContainer;
    },

    drawFrame(mediaTime) {
      const preparedFrame = prepareFrame(mediaTime);

      if (!preparedFrame) {
        hideSprite();
        return;
      }

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
        hideSprite();
        return;
      }

      activeIdMaskFrame = null;

      if (!canHoldVisibleMaskFor(preparedFrame.detectionFrame.mediaTime)) {
        hideSprite();
      }
    },

    prepareFrame(mediaTime) {
      prepareFrame(mediaTime);
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

    getActiveIdMaskFrameTexture() {
      const texture = activeIdMaskFrame
        ? getTexture(activeIdMaskFrame)
        : undefined;

      if (!activeIdMaskFrame || !texture) {
        return null;
      }

      return { frame: activeIdMaskFrame, texture };
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
    },
  };

  function prepareFrame(mediaTime: number) {
    const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

    activeFrameKey = preparedFrame?.key ?? null;

    return preparedFrame;
  }

  function showMaskFrame(maskFrame: PreparedMaskFrame, mediaTime: number) {
    visibleMaskMediaTime = mediaTime;
    activeIdMaskFrame =
      maskFrame.kind === PreparedMaskFrameKind.IdMask ? maskFrame : null;

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

    return new BufferImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      format: maskFrame.rasterFormat,
      height: maskFrame.height,
      resource: maskFrame.raster,
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

  function hideSprite() {
    visibleMaskMediaTime = null;
    activeIdMaskFrame = null;
    hideFill();
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
      return;
    }

    releaseTextureBindings(key, texture);
    maskTextures.delete(key);
    texture.destroy(true);
  }

  function destroyTextures() {
    releaseTextureBindings();

    for (const texture of maskTextures.values()) {
      texture.destroy(true);
    }

    maskTextures.clear();
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
