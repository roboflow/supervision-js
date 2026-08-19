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
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export interface PixiActiveIdMaskFrameTexture {
  readonly frame: PreparedPngIdMaskFrame;
  readonly texture: PixiTexture;
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
  let activeIdMaskFrame: PreparedPngIdMaskFrame | null = null;
  let maskOpacity = resolveMaskStyleOpacity(options.maskStyle);
  let maskPickCanvas: HTMLCanvasElement | undefined;
  let maskPickContext: CanvasRenderingContext2D | null | undefined;
  let maskPickFrameKey: string | null = null;
  let visibleMaskMediaTime: number | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
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

      if (!idMaskRenderer || !options.Container) {
        return maskSprite;
      }

      const maskContainer = new options.Container();
      maskContainer.addChild(maskSprite, idMaskRenderer.mesh);

      return maskContainer;
    },

    drawFrame(mediaTime) {
      const preparedFrame = prepareFrame(mediaTime);

      if (!preparedFrame || !maskSprite) {
        activeIdMaskFrame = null;
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
        activeIdMaskFrame = null;
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

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      preparedRenderWindow.destroy();
      destroyTextures();
      resetMaskPickCanvas();
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
      maskFrame.kind === PreparedMaskFrameKind.PngIdMask ? maskFrame : null;

    if (maskFrame.kind === PreparedMaskFrameKind.PngIdMask && idMaskRenderer) {
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

  function showRgbaMaskFrame(maskFrame: PreparedMaskFrame) {
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
  }

  function hideSprite() {
    visibleMaskMediaTime = null;
    activeIdMaskFrame = null;

    if (maskSprite) {
      maskSprite.visible = false;
    }

    idMaskRenderer?.hide();
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
