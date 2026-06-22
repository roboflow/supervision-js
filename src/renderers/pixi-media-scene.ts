import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
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
import { createPixiFocusLayer } from "./pixi-focus-layer";
import { createPixiInteractionLayer } from "./pixi-interaction-layer";
import { createPixiInteractionPresentationLayer } from "./pixi-interaction-presentation-layer";
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
  let currentLabelStyle: LabelStyle | null = options.labelStyle ?? null;
  let currentMaskStyle: MaskStyle | null = options.maskStyle ?? null;
  const boxLayer = createPixiBoxLayer({
    boxStyle: options.boxStyle,
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
    resolution: resolvePixiResolution(options.maxDevicePixelRatio),
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
  const focusSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Focus);
  const interactionSlot = createPixiSceneLayerSlot(
    PixiSceneLayerKind.Interaction,
  );
  const labelSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Label);
  const layerSlots = [
    mediaSlot,
    maskSlot,
    boxSlot,
    focusSlot,
    interactionSlot,
    labelSlot,
  ];
  let currentMediaTime = 0;
  const interactionLayer = options.interaction
    ? createPixiInteractionLayer({
        Container,
        Rectangle,
        canInteract: options.canInteract,
        detectionTimeline: options.detectionTimeline,
        interaction: options.interaction,
        onStateChange: () => {
          drawFocusLayer(currentMediaTime);
          drawInteractionPresentationLayer(currentMediaTime);
        },
        pickMaskDetectionAtPoint: (point, mediaTime) =>
          maskLayer?.pickDetectionAtPoint(point, mediaTime) ?? null,
      })
    : undefined;
  const interactionPresentationLayer = options.interaction
    ? createPixiInteractionPresentationLayer({
        Container,
        Graphics,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        Text,
        UniformGroup,
        interactionStyle: options.interactionStyle,
      })
    : undefined;
  let focusLayer = options.focusStyle
    ? createPixiFocusLayer({
        Container,
        Graphics,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        UniformGroup,
        focusStyle: options.focusStyle,
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
    rendererBackend: String(app.renderer.name ?? "unknown"),

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
      const interactionDisplay: PixiContainer = new Container();

      mediaSprite.width = mediaWidth;
      mediaSprite.height = mediaHeight;
      boxLayer.attachGraphics(boxes);
      mediaSlot.setDisplay(mediaSprite);
      boxSlot.setDisplay(boxes);
      const interactionPresentationDisplay =
        interactionPresentationLayer?.createDisplay({
          height: mediaHeight,
          width: mediaWidth,
        });
      const interactionHitDisplay = interactionLayer?.createDisplay({
        height: mediaHeight,
        width: mediaWidth,
      });

      if (interactionPresentationDisplay) {
        interactionDisplay.addChild(interactionPresentationDisplay);
      }

      if (interactionHitDisplay) {
        interactionDisplay.addChild(interactionHitDisplay as PixiContainer);
      }

      interactionSlot.setDisplay(
        interactionPresentationDisplay || interactionHitDisplay
          ? interactionDisplay
          : undefined,
      );
      attachFocusLayerDisplay();
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
        currentMediaTime = sample.timestamp;

        if (!collectFrameTimings) {
          sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
          stagingTextureSource?.update();
          stagingTexture?.update();
          maskLayer?.drawFrame(sample.timestamp);
          const boxState = boxLayer.drawFrame(sample.timestamp);
          interactionLayer?.drawFrame(sample.timestamp);
          drawFocusLayer(sample.timestamp);
          drawInteractionPresentationLayer(sample.timestamp);
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
        let focusMs = 0;

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
          drawInteractionPresentationLayer(sample.timestamp);
        });
        focusMs = measure(() => {
          drawFocusLayer(sample.timestamp);
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
          focusMs,
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

    setRenderQuality(maxDevicePixelRatio) {
      const resolution = resolvePixiResolution(maxDevicePixelRatio);
      const screenWidth = options.container.clientWidth || app.screen.width;
      const screenHeight = options.container.clientHeight || app.screen.height;

      app.renderer.resize(screenWidth, screenHeight, resolution);
      updateMediaSceneFit();
    },

    setPresentation(presentation, mediaTime) {
      currentMediaTime = mediaTime;
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

      interactionPresentationLayer?.setInteractionStyle(
        presentation.interactionStyle,
      );

      if (presentation.focusStyle !== undefined) {
        const nextFocusLayer = presentation.focusStyle
          ? ensureFocusLayer(presentation.focusStyle)
          : focusLayer;

        nextFocusLayer?.setFocusStyle(presentation.focusStyle);

        if (presentation.focusStyle) {
          attachFocusLayerDisplay();
          syncSceneChildren();
        }
      }

      if (mediaWidth <= 0 || mediaHeight <= 0) {
        return;
      }

      maskLayer?.drawFrame(mediaTime);
      const boxState = boxLayer.drawFrame(mediaTime);
      interactionLayer?.drawFrame(mediaTime);
      drawFocusLayer(mediaTime);
      drawInteractionPresentationLayer(mediaTime);
      labelLayer?.drawFrame(mediaTime);

      return createPresentedSampleState(mediaTime, boxState);
    },

    setSelectedDetection(selection, mediaTime) {
      currentMediaTime = selection?.mediaTime ?? mediaTime;
      const pick =
        interactionLayer?.setSelectedDetection(
          selection === null
            ? null
            : {
                ...selection,
                mediaTime: selection.mediaTime ?? mediaTime,
              },
        ) ?? null;

      drawFocusLayer(currentMediaTime);
      drawInteractionPresentationLayer(currentMediaTime);

      return pick;
    },

    destroy() {
      app.ticker.remove(updateMediaSceneFit);
      interactionLayer?.destroy();
      interactionPresentationLayer?.destroy();
      focusLayer?.destroy();
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

  function ensureFocusLayer(
    focusStyle: NonNullable<typeof options.focusStyle>,
  ) {
    if (!focusLayer) {
      focusLayer = createPixiFocusLayer({
        Container,
        Graphics,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        UniformGroup,
        focusStyle,
      });
    }

    return focusLayer;
  }

  function attachFocusLayerDisplay() {
    if (
      !focusLayer ||
      focusSlot.getDisplay() ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return;
    }

    focusSlot.setDisplay(
      focusLayer.createDisplay({
        height: mediaHeight,
        width: mediaWidth,
      }) as PixiContainer,
    );
  }

  function drawFocusLayer(mediaTime: number) {
    if (!focusLayer) {
      return;
    }

    const frame = options.detectionTimeline.selectFrame(mediaTime);

    const interactionState = interactionLayer?.getState();

    focusLayer.drawFrame({
      frame,
      hoveredPick: interactionState?.hoveredPick ?? null,
      idMaskArtifact: maskLayer?.getActiveIdMaskFrameTexture() ?? null,
      mediaTime,
      selectedPick: interactionState?.selectedPick ?? null,
    });
  }

  function drawInteractionPresentationLayer(mediaTime: number) {
    if (!interactionPresentationLayer) {
      return;
    }

    const frame = options.detectionTimeline.selectFrame(mediaTime);
    const interactionState = interactionLayer?.getState();

    interactionPresentationLayer.drawFrame({
      frame,
      hoveredPick: interactionState?.hoveredPick ?? null,
      idMaskArtifact: maskLayer?.getActiveIdMaskFrameTexture() ?? null,
      mediaTime,
      selectedPick: interactionState?.selectedPick ?? null,
    });
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

function resolvePixiResolution(maxDevicePixelRatio: number | undefined) {
  const devicePixelRatio = window.devicePixelRatio || 1;

  if (
    maxDevicePixelRatio === undefined ||
    !Number.isFinite(maxDevicePixelRatio) ||
    maxDevicePixelRatio <= 0
  ) {
    return devicePixelRatio;
  }

  return Math.min(devicePixelRatio, maxDevicePixelRatio);
}
