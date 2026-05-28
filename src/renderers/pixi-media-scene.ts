import {
  DEFAULT_OVERLAY_STROKE_ALPHA,
  DEFAULT_OVERLAY_STROKE_COLOR,
  DEFAULT_OVERLAY_STROKE_WIDTH,
  RENDER_ENGINE_PREFERENCE,
} from "../constants/media-renderer";
import type { DecodedVideoSample } from "../media/media-source";
import {
  MediaRendererFit,
  type MediaOverlayFrame,
} from "../types/media-renderer";
import {
  copySortedOverlayFrames,
  selectOverlayFrame,
} from "../utils/overlay-frames";
import type {
  Application as PixiApplication,
  CanvasSource as PixiCanvasSource,
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Texture as PixiTexture,
} from "pixi.js";

type TextureUploadSource = {
  update(): void;
};

type TextureUpload = {
  update(): void;
};

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
}

export interface PixiMediaScene {
  initializeMedia(dimensions: { width: number; height: number }): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  destroy(): void;
}

export async function createPixiMediaScene(options: {
  readonly container: HTMLElement;
  readonly fit: MediaRendererFit;
  readonly overlayFrames: readonly MediaOverlayFrame[] | undefined;
}): Promise<PixiMediaScene> {
  const overlayFrames = copySortedOverlayFrames(options.overlayFrames);
  const { Application, CanvasSource, Container, Graphics, Sprite, Texture } =
    await import("pixi.js");
  const app: PixiApplication = new Application();

  await app.init({
    autoDensity: true,
    backgroundColor: 0x111111,
    preference: RENDER_ENGINE_PREFERENCE,
    resizeTo: options.container,
    resolution: window.devicePixelRatio || 1,
  });

  const rendererCanvas = app.canvas;
  rendererCanvas.style.display = "block";
  rendererCanvas.style.height = "100%";
  rendererCanvas.style.width = "100%";
  options.container.appendChild(rendererCanvas);

  const stagingCanvas = document.createElement("canvas");
  const stagingContext = stagingCanvas.getContext("2d");

  if (!stagingContext) {
    throw new Error("Unable to create staging canvas context.");
  }

  let mediaHeight = 0;
  let mediaWidth = 0;
  let mediaScene: PixiContainer | undefined;
  let overlayGraphics: PixiGraphics | undefined;
  let lastDrawnOverlayFrame: MediaOverlayFrame | undefined;
  let hasDrawnOverlayFrame = false;
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const updateMediaSceneFit = () => {
    if (!mediaScene || mediaWidth <= 0 || mediaHeight <= 0) {
      return;
    }

    const screenWidth = app.screen.width || options.container.clientWidth;
    const screenHeight = app.screen.height || options.container.clientHeight;

    if (screenWidth <= 0 || screenHeight <= 0) {
      return;
    }

    const scale =
      options.fit === MediaRendererFit.Cover
        ? Math.max(screenWidth / mediaWidth, screenHeight / mediaHeight)
        : Math.min(screenWidth / mediaWidth, screenHeight / mediaHeight);

    mediaScene.scale.set(scale);
    mediaScene.position.set(
      (screenWidth - mediaWidth * scale) / 2,
      (screenHeight - mediaHeight * scale) / 2,
    );
  };

  const drawOverlayFrame = (mediaTime: number) => {
    const overlayFrame = selectOverlayFrame(overlayFrames, mediaTime);

    if (hasDrawnOverlayFrame && overlayFrame === lastDrawnOverlayFrame) {
      return {
        activeOverlayFrameTime: overlayFrame?.mediaTime ?? null,
        activeOverlayRectCount: overlayFrame?.rects.length ?? 0,
      };
    }

    hasDrawnOverlayFrame = true;
    lastDrawnOverlayFrame = overlayFrame;
    overlayGraphics?.clear();

    for (const rect of overlayFrame?.rects ?? []) {
      overlayGraphics?.rect(rect.x, rect.y, rect.width, rect.height).stroke({
        alpha: rect.strokeAlpha ?? DEFAULT_OVERLAY_STROKE_ALPHA,
        color: rect.strokeColor ?? DEFAULT_OVERLAY_STROKE_COLOR,
        width: rect.strokeWidth ?? DEFAULT_OVERLAY_STROKE_WIDTH,
      });
    }

    return {
      activeOverlayFrameTime: overlayFrame?.mediaTime ?? null,
      activeOverlayRectCount: overlayFrame?.rects.length ?? 0,
    };
  };

  app.ticker.add(updateMediaSceneFit);

  return {
    initializeMedia({ width, height }) {
      mediaWidth = width;
      mediaHeight = height;
      stagingCanvas.width = mediaWidth;
      stagingCanvas.height = mediaHeight;

      const canvasSource: PixiCanvasSource = new CanvasSource({
        dynamic: true,
        height: mediaHeight,
        resource: stagingCanvas,
        width: mediaWidth,
      });
      const texture: PixiTexture = new Texture({
        dynamic: true,
        source: canvasSource,
      });
      const scene: PixiContainer = new Container();
      const mediaSprite = new Sprite({ texture });
      const overlays: PixiGraphics = new Graphics();

      mediaSprite.width = mediaWidth;
      mediaSprite.height = mediaHeight;
      scene.addChild(mediaSprite, overlays);
      app.stage.addChild(scene);
      mediaScene = scene;
      overlayGraphics = overlays;
      stagingTextureSource = canvasSource;
      stagingTexture = texture;
      updateMediaSceneFit();
    },

    presentSample(sample) {
      if (mediaWidth <= 0 || mediaHeight <= 0) {
        throw new Error("Pixi media scene has not been initialized.");
      }

      try {
        sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
        stagingTextureSource?.update();
        stagingTexture?.update();
        const overlayState = drawOverlayFrame(sample.timestamp);
        updateMediaSceneFit();

        return {
          mediaTime: sample.timestamp,
          ...overlayState,
        };
      } finally {
        sample.close();
      }
    },

    destroy() {
      app.ticker.remove(updateMediaSceneFit);
      app.destroy(
        { removeView: true },
        {
          children: true,
          texture: true,
          textureSource: true,
        },
      );
    },
  };
}
