import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
import { BaseBoxStyle } from "#styles/box-style";
import type { DetectionFrame } from "#types/detections";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
  MediaRendererSceneTimelineContext,
  PresentedMediaSample,
} from "./media-renderer-scene";
import { createPixiBoxLayer, type PixiBoxLayerState } from "./pixi-box-layer";
import { createPixiInteractionLayer } from "./pixi-interaction-layer";
import { createPixiLabelLayer } from "./pixi-label-layer";
import { createPixiMaskLayer } from "./pixi-mask-layer";
import {
  createPixiSceneLayerSlot,
  PixiSceneLayerKind,
  syncPixiSceneLayerChildren,
} from "./pixi-scene-layer-slot";
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
    Mesh,
    MeshGeometry,
    Rectangle,
    Sprite,
    Shader,
    Text,
    Texture,
    UniformGroup,
  } = await import("pixi.js");
  const app: PixiApplication = new Application();
  const initialBoxStyle = options.boxStyle ?? new BaseBoxStyle();
  let currentLabelStyle: LabelStyle | null = options.labelStyle ?? null;
  let currentMaskStyle: MaskStyle | null = options.maskStyle ?? null;
  const boxLayer = createPixiBoxLayer({
    boxStyle: initialBoxStyle,
    detectionTimeline: options.detectionTimeline,
  });
  let maskLayer = options.maskStyle
    ? createPixiMaskLayer({
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        detectionTimeline: options.detectionTimeline,
        maskStyle: options.maskStyle,
        renderPreparation: options.renderPreparation,
      })
    : undefined;
  let labelLayer = options.labelStyle
    ? createPixiLabelLayer({
        Container,
        Graphics,
        Text,
        detectionTimeline: options.detectionTimeline,
        labelStyle: options.labelStyle,
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
  let timelineContext: MediaRendererSceneTimelineContext | undefined;
  const mediaSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Media);
  const maskSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Mask);
  const boxSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Box);
  const interactionSlot = createPixiSceneLayerSlot(
    PixiSceneLayerKind.Interaction,
  );
  const labelSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Label);
  const layerSlots = [mediaSlot, maskSlot, boxSlot, interactionSlot, labelSlot];
  const interactionLayer = options.interaction
    ? createPixiInteractionLayer({
        Container,
        Graphics,
        Rectangle,
        canInteract: options.canInteract,
        detectionTimeline: options.detectionTimeline,
        interaction: options.interaction,
        pickMaskDetectionAtPoint: (point, mediaTime) =>
          maskLayer?.pickDetectionAtPoint(point, mediaTime) ?? null,
      })
    : undefined;
  let mediaSprite: InstanceType<typeof Sprite> | undefined;
  let stagingTexture: TextureUpload | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;
  const collectFrameTimings = options.diagnostics?.frameTimings === true;

  const syncSceneChildren = () => {
    syncPixiSceneLayerChildren(mediaScene, layerSlots);
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
      mediaSprite = new Sprite({ texture });
      const boxes: PixiGraphics = new Graphics();

      mediaSprite.width = mediaWidth;
      mediaSprite.height = mediaHeight;
      boxLayer.attachGraphics(boxes);
      mediaSlot.setDisplay(mediaSprite);
      boxSlot.setDisplay(boxes);
      interactionSlot.setDisplay(
        interactionLayer?.createDisplay({
          height: mediaHeight,
          width: mediaWidth,
        }) as PixiContainer | undefined,
      );
      attachMaskLayerDisplay();
      attachLabelLayerDisplay();
      app.stage.addChild(scene);
      mediaScene = scene;
      syncSceneChildren();
      stagingTextureSource = canvasSource;
      stagingTexture = texture;
      updateMediaSceneFit();
    },

    setTimelineContext(context) {
      timelineContext = context;
      maskLayer?.setTimelineContext(context);
    },

    presentSample(sample) {
      if (mediaWidth <= 0 || mediaHeight <= 0) {
        throw new Error("Pixi media scene has not been initialized.");
      }

      try {
        if (!collectFrameTimings) {
          sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
          stagingTextureSource?.update();
          stagingTexture?.update();
          maskLayer?.drawFrame(sample.timestamp);
          const boxState = boxLayer.drawFrame(sample.timestamp);
          interactionLayer?.drawFrame(sample.timestamp);
          labelLayer?.drawFrame(sample.timestamp);
          updateMediaSceneFit();

          return createPresentedSampleState(sample.timestamp, boxState);
        }

        const totalStart = now();
        let mediaUploadMs = 0;
        let maskMs = 0;
        let boxMs = 0;
        let interactionMs = 0;
        let labelMs = 0;
        let fitMs = 0;

        mediaUploadMs = measure(() => {
          sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
          stagingTextureSource?.update();
          stagingTexture?.update();
        });
        maskMs = measure(() => {
          maskLayer?.drawFrame(sample.timestamp);
        });
        let boxState: PixiBoxLayerState | undefined;

        boxMs = measure(() => {
          boxState = boxLayer.drawFrame(sample.timestamp);
        });
        interactionMs = measure(() => {
          interactionLayer?.drawFrame(sample.timestamp);
        });
        labelMs = measure(() => {
          labelLayer?.drawFrame(sample.timestamp);
        });
        fitMs = measure(updateMediaSceneFit);

        if (!boxState) {
          throw new Error("Unable to draw Pixi box layer.");
        }

        const renderTimings = {
          boxMs,
          fitMs,
          interactionMs,
          labelMs,
          maskMs,
          mediaUploadMs,
          totalMs: elapsedSince(totalStart),
        };

        return {
          ...createPresentedSampleState(sample.timestamp, boxState),
          renderTimings,
        };
      } finally {
        sample.close();
      }
    },

    waitForRenderPreparation(mediaTime, gateOptions) {
      return (
        maskLayer?.waitForRenderPreparation(mediaTime, gateOptions) ??
        Promise.resolve()
      );
    },

    setPresentation(presentation, mediaTime) {
      boxLayer.setBoxStyle(presentation.boxStyle);

      if (presentation.maskStyle !== undefined) {
        currentMaskStyle = presentation.maskStyle;
        const nextMaskLayer = presentation.maskStyle
          ? ensureMaskLayer(presentation.maskStyle)
          : maskLayer;

        nextMaskLayer?.setMaskStyle(presentation.maskStyle);

        if (presentation.maskStyle) {
          attachMaskLayerDisplay();
          syncSceneChildren();
        }
      }

      if (presentation.labelStyle !== undefined) {
        currentLabelStyle = presentation.labelStyle;
        const nextLabelLayer = presentation.labelStyle
          ? ensureLabelLayer(presentation.labelStyle)
          : labelLayer;

        nextLabelLayer?.setLabelStyle(presentation.labelStyle);

        if (presentation.labelStyle) {
          attachLabelLayerDisplay();
          syncSceneChildren();
        }
      }

      if (mediaWidth <= 0 || mediaHeight <= 0) {
        return;
      }

      maskLayer?.drawFrame(mediaTime);
      const boxState = boxLayer.drawFrame(mediaTime);
      interactionLayer?.drawFrame(mediaTime);
      labelLayer?.drawFrame(mediaTime);

      return createPresentedSampleState(mediaTime, boxState);
    },

    destroy() {
      app.ticker.remove(updateMediaSceneFit);
      interactionLayer?.destroy();
      maskLayer?.destroy();
      labelLayer?.destroy();
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

  function createPresentedSampleState(
    mediaTime: number,
    boxState: PixiBoxLayerState,
  ): PresentedMediaSample {
    const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

    return {
      activeDetectionCount: countPresentedDetections(
        detectionFrame,
        mediaTime,
        boxState,
      ),
      activeDetectionFrameIndex: detectionFrame?.frameIndex ?? null,
      activeDetectionFrameTime: detectionFrame?.mediaTime ?? null,
      detectionBuffer: options.detectionTimeline.getState(),
      mediaTime,
    };
  }

  function countPresentedDetections(
    frame: DetectionFrame | undefined,
    mediaTime: number,
    boxState: PixiBoxLayerState,
  ) {
    if (!frame) {
      return 0;
    }

    const visibleDetectionIndexes = new Set(boxState.activeDetectionIndexes);

    for (const [detectionIndex, detection] of frame.detections.entries()) {
      if (visibleDetectionIndexes.has(detectionIndex)) {
        continue;
      }

      if (
        currentMaskStyle?.resolve(detection, {
          detectionIndex,
          frame,
          mediaTime,
        }) ||
        currentLabelStyle?.resolve(detection, {
          detectionIndex,
          frame,
          mediaTime,
        })
      ) {
        visibleDetectionIndexes.add(detectionIndex);
      }
    }

    return visibleDetectionIndexes.size;
  }

  function ensureMaskLayer(maskStyle: NonNullable<typeof options.maskStyle>) {
    if (!maskLayer) {
      maskLayer = createPixiMaskLayer({
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        detectionTimeline: options.detectionTimeline,
        maskStyle,
        renderPreparation: options.renderPreparation,
      });

      if (timelineContext) {
        maskLayer.setTimelineContext(timelineContext);
      }
    }

    return maskLayer;
  }

  function attachMaskLayerDisplay() {
    if (
      !maskLayer ||
      maskSlot.getDisplay() ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return;
    }

    maskSlot.setDisplay(
      maskLayer.createSprite({
        height: mediaHeight,
        width: mediaWidth,
      }) as PixiContainer,
    );
  }

  function ensureLabelLayer(
    labelStyle: NonNullable<typeof options.labelStyle>,
  ) {
    if (!labelLayer) {
      labelLayer = createPixiLabelLayer({
        Container,
        Graphics,
        Text,
        detectionTimeline: options.detectionTimeline,
        labelStyle,
      });
    }

    return labelLayer;
  }

  function attachLabelLayerDisplay() {
    if (!labelLayer || labelSlot.getDisplay()) {
      return;
    }

    labelSlot.setDisplay(labelLayer.createContainer());
  }
}

function measure(work: () => void) {
  const start = now();
  work();
  return elapsedSince(start);
}

function elapsedSince(start: number) {
  return now() - start;
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
