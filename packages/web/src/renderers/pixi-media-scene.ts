import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
import {
  BasePolygonStyle,
  type DetectionFrame,
  type PolygonStyle,
} from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import {
  createViewportController,
  resolveAnnotationStyleState,
} from "supervision-js-core";
import type { AnnotationVisibility } from "supervision-js-core";
import type { Point } from "supervision-js-core";
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
import { createPixiMaskBrushPreview } from "./pixi-mask-brush-preview";
import { createPixiPolygonLayer } from "./pixi-polygon-layer";
import { createPixiVectorLayer } from "./pixi-vector-layer";
import { createPixiAnnotationOverlayLayer } from "./pixi-annotation-overlay-layer";
import {
  AnnotationGestureStateKind,
  MediaInteractionMode,
} from "supervision-js-core";
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
  let currentPolygonStyle: PolygonStyle | null =
    options.polygonStyle === undefined
      ? new BasePolygonStyle()
      : options.polygonStyle;
  let currentVisibility: AnnotationVisibility | undefined = options.visibility;
  let visibilityVersion = 0;
  let visibilityMaskStyleCache: {
    readonly source: MaskStyle;
    readonly style: MaskStyle;
    readonly version: number;
  } | null = null;
  const resolveContextState = (
    detection: DetectionFrame["detections"][number],
  ) => resolveAnnotationStyleState(detection, currentVisibility);
  const resolveLabelContextState = (
    detection: DetectionFrame["detections"][number],
  ) => ({
    ...resolveContextState(detection),
    hidden:
      currentVisibility?.labelsHidden === true ||
      resolveContextState(detection).hidden,
  });
  const boxLayer = createPixiBoxLayer({
    boxStyle: options.boxStyle,
    Container: options.editingEngine ? Container : undefined,
    detectionTimeline: options.detectionTimeline,
    Graphics: options.editingEngine ? Graphics : undefined,
    resolveContextState,
  });
  let polygonLayer =
    options.polygonStyle !== undefined &&
    currentPolygonStyle &&
    !options.editingEngine
      ? createPixiPolygonLayer({
          Container,
          ImageSource,
          Mesh,
          MeshGeometry,
          Shader,
          Sprite,
          Texture,
          UniformGroup,
          detectionTimeline: options.detectionTimeline,
          polygonStyle: currentPolygonStyle,
          renderPreparation: options.renderPreparation,
          resolveContextState,
        })
      : undefined;
  const vectorLayer = createPixiVectorLayer({
    Container,
    Graphics,
    detectionTimeline: options.detectionTimeline,
    polygonStyle: polygonLayer?.getVectorFallbackStyle() ?? currentPolygonStyle,
    polylineStyle: options.polylineStyle,
    keypointStyle: options.keypointStyle,
    resolveContextState,
  });
  const annotationOverlayLayer = createPixiAnnotationOverlayLayer(
    options.editingEngine,
    options.annotationOverlayStyle,
  );
  const maskBrushPreview = options.maskBrush
    ? createPixiMaskBrushPreview({
        CanvasSource,
        Container,
        Graphics,
        Sprite,
        Texture,
        preview: options.maskBrush,
      })
    : undefined;
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
        maskStyle: createVisibilityMaskStyle(options.maskStyle),
        onActiveIdMaskFramePresented: handleActiveIdMaskFramePresented,
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
        resolveContextState: resolveLabelContextState,
      })
    : undefined;

  await app.init({
    autoDensity: true,
    backgroundColor: options.backgroundColor ?? 0x111111,
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
  let vectorDisplay: PixiContainer | undefined;
  let polygonDisplay: PixiContainer | undefined;
  let timelineContext: MediaRendererSceneTimelineContext | undefined;
  const mediaSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Media);
  const maskSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Mask);
  const boxSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Box);
  const vectorSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Vector);
  const focusSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Focus);
  const previewSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Preview);
  const interactionSlot = createPixiSceneLayerSlot(
    PixiSceneLayerKind.Interaction,
  );
  const handleSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Handle);
  const labelSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Label);
  const layerSlots = [
    mediaSlot,
    maskSlot,
    boxSlot,
    vectorSlot,
    focusSlot,
    previewSlot,
    handleSlot,
    interactionSlot,
    labelSlot,
  ];
  let currentMediaTime = 0;
  let viewportScale = 1;
  const viewport = createViewportController({ scale: 1 });
  let hasPresentedSample = false;
  let baseFit: ReturnType<typeof calculatePixiSceneFit>;
  const interactionLayer =
    options.interaction || options.editingEngine
      ? createPixiInteractionLayer({
          Container,
          Rectangle,
          canInteract: options.canInteract,
          detectionTimeline: options.detectionTimeline,
          interaction: options.interaction ?? {
            mode: MediaInteractionMode.Always,
          },
          editingEngine: options.editingEngine,
          capturePointer: (pointerId) => {
            if (!rendererCanvas.hasPointerCapture?.(pointerId)) {
              rendererCanvas.setPointerCapture?.(pointerId);
            }
          },
          getViewportScale: () => viewportScale,
          getMediaDimensions: () => ({
            height: mediaHeight,
            width: mediaWidth,
          }),
          onStateChange: () => {
            drawFocusLayer(currentMediaTime);
            drawInteractionPresentationLayer(currentMediaTime);
            drawAnnotationOverlay();
          },
          pickMaskDetectionAtPoint: (point, mediaTime) =>
            maskLayer?.pickDetectionAtPoint(point, mediaTime) ?? null,
          pickLabelDetectionAtPoint: (point, mediaTime) =>
            labelLayer?.pickDetectionAtPoint(point, mediaTime) ?? null,
          releasePointer: (pointerId) => {
            if (rendererCanvas.hasPointerCapture?.(pointerId)) {
              rendererCanvas.releasePointerCapture?.(pointerId);
            }
          },
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
  let fastTranslatedDetectionId: string | number | null = null;
  const unsubscribeFastTranslate =
    options.editingEngine?.subscribeFastTranslate((id, dx, dy) => {
      fastTranslatedDetectionId = id;
      boxLayer.translateDetection(id, dx, dy);
      vectorLayer.translateDetection(id, dx, dy);
      labelLayer?.translateDetection(id, dx, dy);
    });
  const unsubscribeEditingState = options.editingEngine?.subscribe((state) => {
    if (
      state.kind !== AnnotationGestureStateKind.Idle ||
      fastTranslatedDetectionId === null
    ) {
      return;
    }
    const id = fastTranslatedDetectionId;
    fastTranslatedDetectionId = null;
    boxLayer.translateDetection(id, 0, 0);
    vectorLayer.translateDetection(id, 0, 0);
    labelLayer?.translateDetection(id, 0, 0);
    boxLayer.invalidateDetection(id);
    vectorLayer.invalidateDetection(id);
    boxLayer.drawFrame(currentMediaTime, viewportScale);
    vectorLayer.drawFrame(currentMediaTime, viewportScale);
    labelLayer?.drawFrame(currentMediaTime, viewportScale);
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && interactionLayer) {
      interactionLayer.cycleSelection(event.shiftKey ? -1 : 1);
      event.preventDefault();
      drawInteractionPresentationLayer(currentMediaTime);
      drawAnnotationOverlay();
      return;
    }

    options.editingEngine?.keyDown(event.key);
    drawAnnotationOverlay();
  };
  const handleContextMenu = (event: Event) => {
    if (options.editingEngine) event.preventDefault();
  };
  if (interactionLayer || options.editingEngine) {
    rendererCanvas.tabIndex = 0;
    rendererCanvas.addEventListener?.("keydown", handleKeyDown);
  }
  if (options.editingEngine) {
    rendererCanvas.addEventListener?.("contextmenu", handleContextMenu);
  }
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

    const previousScale = viewportScale;
    baseFit = fit;
    applyViewportTransform();
    if (hasPresentedSample && previousScale !== viewportScale) {
      redrawViewportStyles();
    }
  };

  const applyViewportTransform = () => {
    if (!mediaScene || !baseFit) return;
    const transform = viewport.getTransform();
    viewportScale = baseFit.scale * transform.scale;
    mediaScene.scale.set(viewportScale);
    mediaScene.position.set(baseFit.x + transform.x, baseFit.y + transform.y);
    maskBrushPreview?.setViewportScale(viewportScale);
  };

  const mediaPointToScreen = (point: Point): Point => {
    const fit = baseFit ?? { scale: 1, x: 0, y: 0 };
    const screenPoint = viewport.mediaToScreen({
      x: point.x * fit.scale,
      y: point.y * fit.scale,
    });
    return {
      x: screenPoint.x + fit.x,
      y: screenPoint.y + fit.y,
    };
  };

  const redrawViewportStyles = () => {
    boxLayer.invalidate();
    boxLayer.drawFrame(currentMediaTime, viewportScale);
    polygonLayer?.drawFrame(currentMediaTime, viewportScale);
    vectorLayer.drawFrame(currentMediaTime, viewportScale);
    labelLayer?.drawFrame(currentMediaTime, viewportScale);
    drawFocusLayer(currentMediaTime);
    drawInteractionPresentationLayer(currentMediaTime);
  };

  app.ticker.add(updateMediaSceneFit);
  app.ticker.add(drawAnnotationOverlay);
  const tickFocusLayer = () => focusLayer?.tick(now());
  app.ticker.add(tickFocusLayer);

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
      const retainedBoxes = boxLayer.createContainer();
      const interactionDisplay: PixiContainer = new Container();
      const shouldCreateAnnotationOverlay = Boolean(
        options.editingEngine ||
        options.previewOverlay ||
        currentVisibility?.loadingDetectionIds,
      );
      const annotationOverlay: PixiGraphics | undefined =
        shouldCreateAnnotationOverlay ? new Graphics() : undefined;

      mediaSprite.width = mediaWidth;
      mediaSprite.height = mediaHeight;
      if (!retainedBoxes) boxLayer.attachGraphics(boxes);
      mediaSlot.setDisplay(mediaSprite);
      boxSlot.setDisplay(retainedBoxes ?? boxes);
      vectorDisplay = new Container();
      attachPolygonLayerDisplay();
      vectorDisplay.addChild(vectorLayer.createContainer());
      vectorSlot.setDisplay(vectorDisplay);
      previewSlot.setDisplay(maskBrushPreview?.display);
      if (annotationOverlay) {
        annotationOverlayLayer.attachGraphics(annotationOverlay);
        handleSlot.setDisplay(annotationOverlay);
      }
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
      polygonLayer?.setTimelineContext(context);
    },

    presentSample(sample) {
      if (mediaWidth <= 0 || mediaHeight <= 0) {
        throw new Error("Pixi media scene has not been initialized.");
      }

      try {
        currentMediaTime = sample.timestamp;
        hasPresentedSample = true;

        if (!collectFrameTimings) {
          sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
          stagingTextureSource?.update();
          stagingTexture?.update();
          maskLayer?.drawFrame(sample.timestamp);
          const boxState = boxLayer.drawFrame(sample.timestamp, viewportScale);
          polygonLayer?.drawFrame(sample.timestamp, viewportScale);
          vectorLayer.drawFrame(sample.timestamp, viewportScale);
          interactionLayer?.drawFrame(sample.timestamp);
          drawFocusLayer(sample.timestamp);
          drawInteractionPresentationLayer(sample.timestamp);
          labelLayer?.drawFrame(sample.timestamp, viewportScale);
          updateMediaSceneFit();

          return {
            ...createPresentedSampleState(sample.timestamp, boxState),
            duration: sample.duration,
          };
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
          boxState = boxLayer.drawFrame(sample.timestamp, viewportScale);
          polygonLayer?.drawFrame(sample.timestamp, viewportScale);
          vectorLayer.drawFrame(sample.timestamp, viewportScale);
        });
        interactionMs = measure(() => {
          interactionLayer?.drawFrame(sample.timestamp);
          drawInteractionPresentationLayer(sample.timestamp);
        });
        focusMs = measure(() => {
          drawFocusLayer(sample.timestamp);
        });
        labelMs = measure(() => {
          labelLayer?.drawFrame(sample.timestamp, viewportScale);
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
          duration: sample.duration,
          renderTimings,
        };
      } finally {
        sample.close();
      }
    },

    waitForRenderPreparation(mediaTime, gateOptions) {
      return Promise.all([
        maskLayer?.waitForRenderPreparation(mediaTime, gateOptions),
        polygonLayer?.waitForRenderPreparation(mediaTime, gateOptions),
      ]).then(() => undefined);
    },

    setRenderQuality(maxDevicePixelRatio) {
      const resolution = resolvePixiResolution(maxDevicePixelRatio);
      const screenWidth = options.container.clientWidth || app.screen.width;
      const screenHeight = options.container.clientHeight || app.screen.height;

      app.renderer.resize(screenWidth, screenHeight, resolution);
      updateMediaSceneFit();
    },

    setDisplayAdjustments(adjustments) {
      void import("pixi.js").then(({ ColorMatrixFilter }) => {
        const filter = new ColorMatrixFilter();
        filter.brightness(adjustments.brightness ?? 1, false);
        filter.contrast((adjustments.contrast ?? 1) - 1, true);
        if (mediaSprite) mediaSprite.filters = [filter];
      });
    },

    getViewportTransform() {
      const transform = viewport.getTransform();
      return {
        locked: transform.locked,
        scale: viewportScale,
        x: (baseFit?.x ?? 0) + transform.x,
        y: (baseFit?.y ?? 0) + transform.y,
      };
    },

    setViewportTransform(transform) {
      viewport.setTransform({
        ...(transform.scale === undefined || !baseFit
          ? {}
          : { scale: transform.scale / baseFit.scale }),
        ...(transform.x === undefined
          ? {}
          : { x: transform.x - (baseFit?.x ?? 0) }),
        ...(transform.y === undefined
          ? {}
          : { y: transform.y - (baseFit?.y ?? 0) }),
      });
      applyViewportTransform();
      redrawViewportStyles();
    },

    setViewportLocked(locked) {
      viewport.setLocked(locked);
    },

    screenToMedia(point) {
      const fit = baseFit ?? { scale: 1, x: 0, y: 0 };
      const fitPoint = viewport.screenToMedia({
        x: point.x - fit.x,
        y: point.y - fit.y,
      });
      return {
        x: fitPoint.x / fit.scale,
        y: fitPoint.y / fit.scale,
      };
    },

    mediaToScreen(point) {
      return mediaPointToScreen(point);
    },

    getDetectionLabelBounds(detectionId) {
      const bounds = labelLayer?.getDetectionLabelBounds(detectionId);
      if (!bounds) return null;
      const topLeft = mediaPointToScreen({ x: bounds.x, y: bounds.y });
      const bottomRight = mediaPointToScreen({
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
      });
      return {
        height: bottomRight.y - topLeft.y,
        width: bottomRight.x - topLeft.x,
        x: topLeft.x,
        y: topLeft.y,
      };
    },

    panViewportBy(dx, dy) {
      const before = viewport.getTransform();
      viewport.panBy(dx, dy);
      const after = viewport.getTransform();
      viewport.setTransform({ x: Math.round(after.x), y: Math.round(after.y) });
      if (before === viewport.getTransform()) return;
      applyViewportTransform();
    },

    zoomViewportAt(point, factor) {
      if (!baseFit) return;
      viewport.zoomAt(
        { x: point.x - baseFit.x, y: point.y - baseFit.y },
        factor,
      );
      const transform = viewport.getTransform();
      viewport.setTransform({
        x: Math.round(transform.x),
        y: Math.round(transform.y),
      });
      applyViewportTransform();
      redrawViewportStyles();
    },

    zoomViewportFromWheel(point, deltaY) {
      if (!baseFit) return;
      viewport.zoomFromWheel(
        { x: point.x - baseFit.x, y: point.y - baseFit.y },
        deltaY,
      );
      const transform = viewport.getTransform();
      viewport.setTransform({
        x: Math.round(transform.x),
        y: Math.round(transform.y),
      });
      applyViewportTransform();
      redrawViewportStyles();
    },

    setPresentation(presentation, mediaTime) {
      currentMediaTime = mediaTime;
      if (presentation.backgroundColor !== undefined) {
        app.renderer.background.color = presentation.backgroundColor;
      }
      annotationOverlayLayer.setStyle(presentation.annotationOverlayStyle);
      if (presentation.visibility !== undefined) {
        const maskVisibilityChanged = !canReuseMaskVisibilityArtifacts(
          currentVisibility,
          presentation.visibility,
        );
        currentVisibility = presentation.visibility;
        boxLayer.invalidate();
        vectorLayer.setStyles({});
        labelLayer?.setLabelStyle(currentLabelStyle);
        polygonLayer?.setPolygonStyle(currentPolygonStyle);
        if (maskVisibilityChanged && currentMaskStyle) {
          visibilityVersion += 1;
          maskLayer?.setMaskStyle(createVisibilityMaskStyle(currentMaskStyle));
        }
      }
      boxLayer.setBoxStyle(presentation.boxStyle);
      if (presentation.polygonStyle !== undefined) {
        currentPolygonStyle = presentation.polygonStyle;
        const nextPolygonLayer = presentation.polygonStyle
          ? ensurePolygonLayer(presentation.polygonStyle)
          : polygonLayer;

        nextPolygonLayer?.setPolygonStyle(presentation.polygonStyle);
        vectorLayer.setStyles({
          polygonStyle:
            nextPolygonLayer?.getVectorFallbackStyle() ??
            presentation.polygonStyle,
        });

        if (presentation.polygonStyle && nextPolygonLayer) {
          attachPolygonLayerDisplay();
        }
      }

      vectorLayer.setStyles({
        polylineStyle: presentation.polylineStyle,
        keypointStyle: presentation.keypointStyle,
      });

      if (presentation.maskStyle !== undefined) {
        currentMaskStyle = presentation.maskStyle;
        const nextMaskLayer = presentation.maskStyle
          ? ensureMaskLayer(presentation.maskStyle)
          : maskLayer;

        nextMaskLayer?.setMaskStyle(
          presentation.maskStyle
            ? createVisibilityMaskStyle(presentation.maskStyle)
            : presentation.maskStyle,
        );

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
      const boxState = boxLayer.drawFrame(mediaTime, viewportScale);
      polygonLayer?.drawFrame(mediaTime, viewportScale);
      vectorLayer.drawFrame(mediaTime, viewportScale);
      interactionLayer?.drawFrame(mediaTime);
      drawFocusLayer(mediaTime);
      drawInteractionPresentationLayer(mediaTime);
      labelLayer?.drawFrame(mediaTime, viewportScale);

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
      app.ticker.remove(drawAnnotationOverlay);
      app.ticker.remove(tickFocusLayer);
      interactionLayer?.destroy();
      interactionPresentationLayer?.destroy();
      focusLayer?.destroy();
      maskLayer?.destroy();
      polygonLayer?.destroy();
      labelLayer?.destroy();
      vectorLayer.destroy();
      maskBrushPreview?.destroy();
      unsubscribeFastTranslate?.();
      unsubscribeEditingState?.();
      if (interactionLayer || options.editingEngine) {
        rendererCanvas.removeEventListener?.("keydown", handleKeyDown);
      }
      if (options.editingEngine) {
        rendererCanvas.removeEventListener?.("contextmenu", handleContextMenu);
      }
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
          viewportScale,
          ...resolveContextState(detection),
        }) ||
        currentLabelStyle?.resolve(detection, {
          detectionIndex,
          frame,
          mediaTime,
          viewportScale,
          ...resolveLabelContextState(detection),
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
        maskStyle: createVisibilityMaskStyle(maskStyle),
        onActiveIdMaskFramePresented: handleActiveIdMaskFramePresented,
        renderPreparation: options.renderPreparation,
      });

      if (timelineContext) {
        maskLayer.setTimelineContext(timelineContext);
      }
    }

    return maskLayer;
  }

  function ensurePolygonLayer(polygonStyle: PolygonStyle) {
    if (options.editingEngine) {
      return undefined;
    }

    if (!polygonLayer) {
      polygonLayer = createPixiPolygonLayer({
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        detectionTimeline: options.detectionTimeline,
        polygonStyle,
        renderPreparation: options.renderPreparation,
        resolveContextState,
      });

      if (timelineContext) {
        polygonLayer.setTimelineContext(timelineContext);
      }
    }

    return polygonLayer;
  }

  function attachPolygonLayerDisplay() {
    if (
      !polygonLayer ||
      polygonDisplay ||
      !vectorDisplay ||
      mediaWidth <= 0 ||
      mediaHeight <= 0
    ) {
      return;
    }

    polygonDisplay = polygonLayer.createDisplay({
      height: mediaHeight,
      width: mediaWidth,
    }) as PixiContainer;
    if (typeof vectorDisplay.addChildAt === "function") {
      vectorDisplay.addChildAt(polygonDisplay, 0);
    } else {
      vectorDisplay.addChild(polygonDisplay);
    }
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

    const editingKind = options.editingEngine?.getState().kind;
    if (
      editingKind === AnnotationGestureStateKind.Creating ||
      editingKind === AnnotationGestureStateKind.DragSelecting
    ) {
      focusLayer.drawFrame({
        frame: undefined,
        hoveredPick: null,
        mediaTime,
        selectedPick: null,
      });
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
      viewportScale,
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
      selectedPicks: interactionState?.selectedPicks,
      viewportScale,
    });
  }

  function handleActiveIdMaskFramePresented() {
    drawFocusLayer(currentMediaTime);
    drawInteractionPresentationLayer(currentMediaTime);
  }

  function drawAnnotationOverlay() {
    const frame = options.detectionTimeline.selectFrame(currentMediaTime);
    const interactionState = interactionLayer?.getState();
    annotationOverlayLayer.draw({
      frame,
      marquee: interactionState?.marqueeRect ?? null,
      mediaHeight,
      mediaWidth,
      now: now(),
      pointer: interactionState?.pointerPoint ?? null,
      previewOverlay: options.previewOverlay?.() ?? null,
      selectedDetectionIds: (interactionState?.selectedPicks ?? []).flatMap(
        ({ detection }) => (detection.id === undefined ? [] : [detection.id]),
      ),
      viewportScale,
      visibility: currentVisibility,
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
        resolveContextState: resolveLabelContextState,
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

  function createVisibilityMaskStyle(style: MaskStyle): MaskStyle {
    if (
      visibilityMaskStyleCache?.source === style &&
      visibilityMaskStyleCache.version === visibilityVersion
    ) {
      return visibilityMaskStyleCache.style;
    }

    const visibilityMaskStyle: MaskStyle = {
      artifactKey:
        style.artifactKey === undefined
          ? undefined
          : `${style.artifactKey}:visibility:${visibilityVersion}`,
      opacity: style.opacity,
      resolve(detection, context) {
        const state = resolveContextState(detection);
        if (state.hidden) return undefined;
        return style.resolve(detection, { ...context, ...state });
      },
    };

    visibilityMaskStyleCache = {
      source: style,
      style: visibilityMaskStyle,
      version: visibilityVersion,
    };

    return visibilityMaskStyle;
  }
}

export function canReuseMaskVisibilityArtifacts(
  previous: AnnotationVisibility | undefined,
  next: AnnotationVisibility | undefined,
) {
  return (
    (previous?.annotationsHidden === true) ===
      (next?.annotationsHidden === true) &&
    previous?.creatingDetectionId === next?.creatingDetectionId &&
    haveEqualVisibilityValues(previous?.hiddenClasses, next?.hiddenClasses) &&
    haveEqualVisibilityValues(
      previous?.hiddenDetectionIds,
      next?.hiddenDetectionIds,
    ) &&
    haveEqualVisibilityValues(
      previous?.loadingDetectionIds,
      next?.loadingDetectionIds,
    ) &&
    haveEqualVisibilityValues(
      previous?.ephemeralDetectionIds,
      next?.ephemeralDetectionIds,
    )
  );
}

function haveEqualVisibilityValues<T>(
  previous: ReadonlySet<T> | readonly T[] | undefined,
  next: ReadonlySet<T> | readonly T[] | undefined,
) {
  if (previous === next) {
    return true;
  }

  const previousValues = new Set(previous ?? []);
  const nextValues = new Set(next ?? []);

  return (
    previousValues.size === nextValues.size &&
    Array.from(previousValues).every((value) => nextValues.has(value))
  );
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
