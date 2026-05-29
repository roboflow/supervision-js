import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
} from "./media-renderer-scene";
import { createPixiBoxLayer } from "./pixi-box-layer";
import { createPixiMaskLayer } from "./pixi-mask-layer";
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

export async function createPixiMediaScene(
  options: MediaRendererSceneOptions,
): Promise<MediaRendererScene> {
  const {
    Application,
    CanvasSource,
    Container,
    Graphics,
    ImageSource,
    Sprite,
    Texture,
  } = await import("pixi.js");
  const app: PixiApplication = new Application();
  const boxLayer = createPixiBoxLayer({
    boxStyle: options.boxStyle,
    detectionTimeline: options.detectionTimeline,
  });
  let maskLayer = options.maskStyle
    ? createPixiMaskLayer({
        ImageSource,
        Sprite,
        Texture,
        detectionTimeline: options.detectionTimeline,
        maskStyle: options.maskStyle,
        renderPreparation: options.renderPreparation,
      })
    : undefined;

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
  let boxGraphics: PixiGraphics | undefined;
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;

  const attachMaskSprite = () => {
    if (!mediaScene || !maskLayer || !boxGraphics) {
      return;
    }

    const maskSprite = maskLayer.createSprite({
      height: mediaHeight,
      width: mediaWidth,
    });
    mediaScene.addChild(maskSprite);
    mediaScene.addChild(boxGraphics);
  };

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
      const maskSprite = maskLayer?.createSprite({
        height: mediaHeight,
        width: mediaWidth,
      });
      const boxes: PixiGraphics = new Graphics();

      mediaSprite.width = mediaWidth;
      mediaSprite.height = mediaHeight;
      boxLayer.attachGraphics(boxes);
      boxGraphics = boxes;
      if (maskSprite) {
        scene.addChild(mediaSprite, maskSprite, boxes);
      } else {
        scene.addChild(mediaSprite, boxes);
      }
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
        maskLayer?.drawFrame(sample.timestamp);
        const boxState = boxLayer.drawFrame(sample.timestamp);
        updateMediaSceneFit();

        return {
          detectionBuffer: options.detectionTimeline.getState(),
          mediaTime: sample.timestamp,
          ...boxState,
        };
      } finally {
        sample.close();
      }
    },

    setPresentation(presentation, mediaTime) {
      boxLayer.setBoxStyle(presentation.boxStyle);

      if (presentation.maskStyle !== undefined) {
        if (maskLayer) {
          maskLayer.setMaskStyle(presentation.maskStyle);
        } else if (presentation.maskStyle) {
          maskLayer = createPixiMaskLayer({
            ImageSource,
            Sprite,
            Texture,
            detectionTimeline: options.detectionTimeline,
            maskStyle: presentation.maskStyle,
            renderPreparation: options.renderPreparation,
          });
          attachMaskSprite();
        }
      }

      if (mediaWidth <= 0 || mediaHeight <= 0) {
        return;
      }

      maskLayer?.drawFrame(mediaTime);
      boxLayer.drawFrame(mediaTime);
    },

    destroy() {
      app.ticker.remove(updateMediaSceneFit);
      maskLayer?.destroy();
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
