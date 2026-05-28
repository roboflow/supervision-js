import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
import type { DecodedVideoSample } from "#media/media-source";
import {
  MediaRendererFit,
  type MediaOverlayFrame,
} from "#types/media-renderer";
import { createPixiOverlayLayer } from "./pixi-overlay-layer";
import { calculatePixiSceneFit } from "./pixi-scene-fit";
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
  const { Application, CanvasSource, Container, Graphics, Sprite, Texture } =
    await import("pixi.js");
  const app: PixiApplication = new Application();
  const overlayLayer = createPixiOverlayLayer({
    overlayFrames: options.overlayFrames,
  });

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
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const updateMediaSceneFit = () => {
    if (!mediaScene || mediaWidth <= 0 || mediaHeight <= 0) {
      return;
    }

    const screenWidth = app.screen.width || options.container.clientWidth;
    const screenHeight = app.screen.height || options.container.clientHeight;

    const fit = calculatePixiSceneFit({
      fit: options.fit,
      mediaHeight,
      mediaWidth,
      screenHeight,
      screenWidth,
    });

    if (!fit) {
      return;
    }

    mediaScene.scale.set(fit.scale);
    mediaScene.position.set(fit.x, fit.y);
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
      overlayLayer.attachGraphics(overlays);
      scene.addChild(mediaSprite, overlays);
      app.stage.addChild(scene);
      mediaScene = scene;
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
        const overlayState = overlayLayer.drawFrame(sample.timestamp);
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
