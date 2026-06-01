import {
  createPreparedRenderWindow,
  PreparedRenderFrameMaskStatus,
  type PreparedMaskFrame,
  type PreparedRenderTimelineContext,
} from "#render-preparation/prepared-render-window";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { MaskStyle } from "#types/mask-style";
import type {
  RenderPreparationOptions,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import { resolveMaskStyleOpacity } from "#utils/mask-style";
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
  setTimelineContext(context: PreparedRenderTimelineContext): void;
  setMaskStyle(maskStyle: MaskStyle | null | undefined): void;
  destroy(): void;
}

export function createPixiMaskLayer(options: {
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
  readonly renderPreparation?: RenderPreparationOptions;
}): PixiMaskLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let idMaskRenderer:
    | ReturnType<typeof createPixiIdMaskShaderRenderer>
    | undefined;
  let maskSprite: PixiSprite | undefined;
  let activeFrameKey: string | null = null;
  let activeFrameMediaTime: number | null = null;
  let maskOpacity = resolveMaskStyleOpacity(options.maskStyle);
  let visibleMaskMediaTime: number | null = null;
  let isDestroyed = false;
  const maskTextures = new Map<string, PixiTexture>();
  const preparedRenderWindow = createPreparedRenderWindow({
    detectionTimeline: options.detectionTimeline,
    maskStyle: options.maskStyle,
    onMaskFrameEvicted(key) {
      destroyTexture(key);
      if (key === activeFrameKey) {
        activeFrameKey = null;
        activeFrameMediaTime = null;
        hideSprite();
      }
    },
    onMaskFramePrepared(maskFrame) {
      if (!isDestroyed && maskFrame.key === activeFrameKey) {
        showMaskFrame(maskFrame, activeFrameMediaTime);
      }
    },
    onMaskFramesCleared() {
      activeFrameKey = null;
      activeFrameMediaTime = null;
      destroyTextures();
      hideSprite();
    },
    renderPreparation: options.renderPreparation,
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
      const preparedFrame = preparedRenderWindow.getFrame(mediaTime);

      if (!preparedFrame || !maskSprite) {
        activeFrameKey = preparedFrame?.key ?? null;
        activeFrameMediaTime = preparedFrame?.detectionFrame.mediaTime ?? null;
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
        hideSprite();
        return;
      }

      if (!canHoldVisibleMaskFor(preparedFrame.detectionFrame.mediaTime)) {
        hideSprite();
      }
    },

    waitForRenderPreparation(mediaTime, gateOptions) {
      return preparedRenderWindow.waitForReady(mediaTime, gateOptions);
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
      idMaskRenderer?.destroy();
    },
  };

  function showMaskFrame(
    maskFrame: PreparedMaskFrame,
    mediaTime: number | null,
  ) {
    visibleMaskMediaTime = mediaTime;

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
}
