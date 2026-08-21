import { RENDER_ENGINE_PREFERENCE } from "#constants/media-renderer";
import {
  BasePolygonStyle,
  RegionRendererCoverageKind,
  RegionRendererSourceKind,
  type BoxCornerStyle,
  type Detection,
  type DetectionFrame,
  type EllipseStyle,
  type MarkerStyle,
  type MaskHaloStyle,
  type PolygonStyle,
  type RegionAnnotationRenderer,
  type RegionRendererTarget,
  type ShapeStyle,
} from "supervision-js-core";
import type { FocusStyle } from "supervision-js-core";
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
import type { MediaRendererPresentation } from "#types/media-renderer";
import { captureCanvasMediaFrame } from "./media-frame-capture";
import { presentVideoFrame } from "./pixi-frame-present";
import type { FramePresentTargets } from "./pixi-frame-present";
import type { PresentedVideoFrame } from "./presented-frame-channel";
import { createSceneRenderScheduler } from "./scene-render-scheduler";
import type { SceneRenderSignature } from "./scene-render-scheduler";
import { createPreparedAnnotationWindow } from "./prepared-annotation-window";
import { createPixiBoxLayer, type PixiBoxLayerState } from "./pixi-box-layer";
import { createPixiFocusLayer } from "./pixi-focus-layer";
import { createPixiInteractionLayer } from "./pixi-interaction-layer";
import { createPixiInteractionPresentationLayer } from "./pixi-interaction-presentation-layer";
import { createPixiLabelLayer } from "./pixi-label-layer";
import {
  createPixiMaskLayer,
  ID_MASK_PREPARATION_STYLE,
} from "./pixi-mask-layer";
import { createPixiMaskBrushPreview } from "./pixi-mask-brush-preview";
import { createPixiPolygonLayer } from "./pixi-polygon-layer";
import { createPixiVectorLayer } from "./pixi-vector-layer";
import { resolveAnnotationShapeStyle } from "./annotation-shape-styles";
import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import {
  createPixiRegionLayer,
  type PixiRegionLayerState,
} from "./pixi-region-layer";
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
  ExternalSource as PixiExternalSource,
  Graphics as PixiGraphics,
  Texture as PixiTexture,
} from "pixi.js";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Halo-only and coverage-only presentations still need a prepared artifact.
 * Neither draws a fill, so both resolve to nothing visible and exist only to
 * keep preparation running.
 */
const HALO_ONLY_MASK_STYLE: MaskStyle = {
  artifactKey: "mask-halo-only",
  resolve: (detection) =>
    detection.mask
      ? { alpha: 0, color: 0x000000, mask: detection.mask }
      : undefined,
};

const REGION_COVERAGE_ONLY_MASK_STYLE: MaskStyle = {
  artifactKey: "region-mask-coverage-only",
  resolve: () => undefined,
};

/**
 * How far a focus change with no frame behind it moves the focus layer's fade.
 * It eases over elapsed milliseconds, and a push-presented scene only ever has
 * media time, so anything past a fade's length lands the overlay at once.
 */
const STATIC_FOCUS_SETTLE_MS = 10_000;

export function observePixiContainerResize(
  container: HTMLElement,
  resize: () => void,
): () => void {
  const ResizeObserverConstructor = globalThis.ResizeObserver;
  if (!ResizeObserverConstructor) {
    return () => undefined;
  }

  const observer = new ResizeObserverConstructor(() => resize());
  observer.observe(container);
  return () => observer.disconnect();
}

type TextureUploadSource = {
  update(): void;
};

type MediaCompositor = {
  upload(frame: VideoFrame): void;
  destroy(): void;
};

/** The binding a compositor points at whichever texture holds the last frame. */
export interface MediaGpuTextureSource {
  updateGPUTexture(texture: GPUTexture): void;
}

export interface MediaCompositorOptions {
  readonly device: GPUDevice;
  readonly height: number;
  readonly width: number;
  /**
   * Puts the compositor's first texture on screen and returns the binding every
   * later texture replaces it through.
   */
  readonly attach: (texture: GPUTexture) => MediaGpuTextureSource;
  /** Runs after a decode of a new size swapped the texture underneath. */
  readonly onTextureReplaced: () => void;
}

/**
 * Two ways to drive the same layer stack.
 *
 * Pull presentation is the default: the renderer asks the media source for the
 * sample it wants, hands it to `presentSample`, and Pixi's ticker paints the
 * scene every frame.
 *
 * Push presentation engages when the opened source carries a presented-frame
 * channel. The producer then decides which frame is on screen and announces it,
 * so the ticker paints nothing and every render is an explicit answer to a
 * change: a presented frame, a layer turned on or off, restyling, hover or
 * selection, a viewport move, a resize, or the swapchain coming back after the
 * tab was hidden. A notification that describes what is already drawn renders
 * nothing, so a paused scene nobody touches renders nothing at all.
 *
 * The focus layer's fade is not an exception to that. It advances with the
 * presented media time, so it fades during playback and is applied at once when
 * a hover or selection arrives with no frame behind it: paused focus is static,
 * and no animation keeps the scene rendering on its own.
 */
export async function createPixiMediaScene(
  options: MediaRendererSceneOptions,
): Promise<MediaRendererScene> {
  const pixi = await import("pixi.js");
  const {
    AlphaMask,
    Application,
    Assets,
    BlurFilter,
    BufferImageSource,
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
  } = pixi;
  const { GifSprite } = await import("pixi.js/gif");
  const app: PixiApplication = new Application();
  /**
   * WebGPU takes any bytesPerRow, so id rasters of any width go up one byte per
   * pixel. WebGL rejects a single-channel upload whose width is not a multiple
   * of four (measured: GL_INVALID_OPERATION, blank texture), and the layer pays
   * four channels there instead. The renderer is only known after init.
   */
  const acceptsUnalignedTextureRows = () => app.renderer?.name === "webgpu";
  const frameChannel = options.presentedFrames;
  let currentFocusStyle: FocusStyle | null = options.focusStyle ?? null;
  let currentLabelStyle: LabelStyle | null = options.labelStyle ?? null;
  let currentMaskStyle: MaskStyle | null = options.maskStyle ?? null;
  let currentMaskHaloStyle: MaskHaloStyle | null =
    options.maskHaloStyle ?? null;
  let currentBoxCornerStyle: BoxCornerStyle | null =
    options.boxCornerStyle ?? null;
  let currentEllipseStyle: EllipseStyle | null = options.ellipseStyle ?? null;
  let currentMarkerStyle: MarkerStyle | null = options.markerStyle ?? null;
  let currentRegionRenderers: readonly RegionAnnotationRenderer[] =
    options.regionRenderers;
  let regionMaskCoverageKey = resolveRegionMaskCoverageKey(
    currentRegionRenderers,
  );
  let currentPolygonStyle: PolygonStyle | null =
    options.polygonStyle === undefined
      ? new BasePolygonStyle()
      : options.polygonStyle;
  let currentVisibility: AnnotationVisibility | undefined = options.visibility;
  let currentMediaTime = 0;
  let isPlaybackActive = true;
  let displayBrightness = 1;
  let displayContrast = 1;
  let viewportScale = 1;
  let hasPresentedSample = false;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let visibilityVersion = 0;
  let visibilityMaskStyleCache: {
    readonly source: MaskStyle;
    readonly style: MaskStyle;
    readonly version: number;
  } | null = null;
  let regionCoverageStyleCache: {
    readonly key: string;
    readonly source: MaskStyle;
    readonly style: MaskStyle;
  } | null = null;
  const annotationWindow = createPreparedAnnotationWindow({
    detectionTimeline: options.detectionTimeline,
    getLayers: () =>
      [maskLayer, polygonLayer].filter(
        (layer): layer is NonNullable<typeof layer> => layer !== undefined,
      ),
    getPlayheadMediaTime: () => currentMediaTime,
    renderPreparation: options.renderPreparation,
  });
  /**
   * What the annotation layers read. Under push presentation that is the
   * window, so a frame it does not cover reaches no layer at all; a pull scene
   * keeps drawing whatever the timeline holds.
   */
  const annotationDetectionTimeline = frameChannel
    ? annotationWindow.preparedFrameTimeline
    : options.detectionTimeline;
  /** What the window answered for the media time the layers last drew. */
  let drawnReadiness: string | null = null;
  let isPresenting = false;
  let isDestroyed = false;
  let displayFrameHandle: number | null = null;
  let hasDeferredPresentRender = false;
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
    detectionTimeline: annotationDetectionTimeline,
    Graphics: options.editingEngine ? Graphics : undefined,
    resolveContextState,
  });
  let polygonLayer =
    options.polygonStyle !== undefined &&
    currentPolygonStyle &&
    !options.editingEngine
      ? createPixiPolygonLayer({
          BufferImageSource,
          Container,
          ImageSource,
          Mesh,
          MeshGeometry,
          Shader,
          Sprite,
          Texture,
          UniformGroup,
          acceptsUnalignedTextureRows,
          detectionTimeline: options.detectionTimeline,
          onPreparedWindowChange: handlePreparedWindowChange,
          polygonStyle: currentPolygonStyle,
          renderPreparation: options.renderPreparation,
          resolveContextState,
        })
      : undefined;
  const vectorLayer = createPixiVectorLayer({
    Container,
    Graphics,
    detectionTimeline: annotationDetectionTimeline,
    polygonStyle: polygonLayer?.getVectorFallbackStyle() ?? currentPolygonStyle,
    polylineStyle: options.polylineStyle,
    keypointStyle: options.keypointStyle,
    shapeStyle: resolveVectorShapeStyle(),
    resolveContextState,
  });
  const regionLayer = createPixiRegionLayer({
    AlphaMask,
    Assets,
    Container,
    GifSprite,
    Graphics,
    ImageSource,
    Mesh,
    MeshGeometry,
    Rectangle,
    Shader,
    Sprite,
    Texture,
    UniformGroup,
    detectionTimeline: annotationDetectionTimeline,
    getActiveRegionMaskCoverage: () =>
      maskLayer?.getActiveRegionMaskCoverage() ?? null,
    getMediaTexture: () => (hasPresentedSample ? stagingTexture : undefined),
    onInvalidate: () => {
      if (!hasPresentedSample || mediaWidth <= 0 || mediaHeight <= 0) return;
      const boxState = boxLayer.drawFrame(currentMediaTime, viewportScale);
      const regionState = regionLayer.drawFrame(
        currentMediaTime,
        viewportScale,
      );
      options.onPresentationUpdate?.(
        createPresentedSampleState(currentMediaTime, boxState, regionState),
      );
      renderNow();
    },
    onAssetError: options.diagnostics?.onAssetError,
    regionRenderers: currentRegionRenderers,
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
  const initialMaskPreparationStyle = resolveMaskPreparationStyle();
  let maskLayer = initialMaskPreparationStyle
    ? createPixiMaskLayer({
        BlurFilter,
        BufferImageSource,
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Rectangle,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        acceptsUnalignedTextureRows,
        detectionTimeline: options.detectionTimeline,
        maskHaloStyle: resolveVisibilityMaskHaloStyle(),
        maskStyle: initialMaskPreparationStyle,
        onPreparedWindowChange: handlePreparedWindowChange,
        renderPreparation: options.renderPreparation,
        resolveInstructions: resolveArtifactMaskInstructions,
      })
    : undefined;

  maskLayer?.setFillVisible(currentMaskStyle !== null);
  let labelLayer = options.labelStyle
    ? createPixiLabelLayer({
        Container,
        Graphics,
        Text,
        detectionTimeline: annotationDetectionTimeline,
        labelStyle: options.labelStyle,
        resolveContextState: resolveLabelContextState,
      })
    : undefined;

  await app.init({
    autoDensity: true,
    autoStart: frameChannel === undefined,
    backgroundColor: options.backgroundColor ?? 0x111111,
    preference: frameChannel ? "webgpu" : RENDER_ENGINE_PREFERENCE,
    resolution: resolvePixiResolution(options.maxDevicePixelRatio),
  });

  const rendererCanvas = app.canvas;
  rendererCanvas.style.display = "block";
  rendererCanvas.style.position = "absolute";
  const backdrop = createSceneBackdrop(options.backgroundColor);
  backdrop.appendChild(rendererCanvas);
  options.container.appendChild(backdrop);

  const stagingCanvas = document.createElement("canvas");
  const stagingContext = stagingCanvas.getContext("2d");

  if (!stagingContext) {
    throw new Error("Unable to create staging canvas context.");
  }

  const renderScheduler = createSceneRenderScheduler(() => app.render());
  let appliedPresentation: MediaRendererPresentation | undefined;
  let mediaCompositor: MediaCompositor | undefined;
  let presentedFrameSerial = 0;
  let focusAnimationTimeMs = 0;
  let focusAnimationMediaTimeMs: number | null = null;
  let mediaScene: PixiContainer | undefined;
  let vectorDisplay: PixiContainer | undefined;
  let polygonDisplay: PixiContainer | undefined;
  let timelineContext: MediaRendererSceneTimelineContext | undefined;
  const mediaSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Media);
  const maskSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Mask);
  const boxSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Box);
  const vectorSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Vector);
  const regionSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Region);
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
    regionSlot,
    focusSlot,
    previewSlot,
    handleSlot,
    interactionSlot,
    labelSlot,
  ];
  const viewport = createViewportController({ scale: 1 });
  /**
   * Timestamp of the sample whose pixels are on screen. Unlike
   * `currentMediaTime`, presentation and selection updates never move it.
   */
  let presentedSampleTimestamp: number | null = null;
  /**
   * Surface holding those pixels. The GPU compositor keeps them in a texture no
   * canvas ever sees, so a capture has to read them back through Pixi.
   */
  let readPresentedSurface = () => stagingCanvas;
  let baseFit: ReturnType<typeof calculatePixiSceneFit>;
  let presentationBox = { height: 0, left: 0, top: 0, width: 0 };
  /**
   * Read only when the observer says the box moved. The fit is recomputed on
   * every presented sample, and reading the element there would put a forced
   * layout in the frame path.
   */
  const containerSize = { height: 0, width: 0 };
  const measureContainer = () => {
    containerSize.width = options.container.clientWidth || containerSize.width;
    containerSize.height =
      options.container.clientHeight || containerSize.height;
  };
  let presentationResolution = resolvePixiResolution(
    options.maxDevicePixelRatio,
  );
  let appliedResolution: number | undefined;
  const interactionLayer =
    options.interaction || options.editingEngine
      ? createPixiInteractionLayer({
          Container,
          Rectangle,
          canInteract: options.canInteract,
          detectionTimeline: annotationDetectionTimeline,
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
            drawAnnotationOverlay(currentMediaTime, overlayNow());
            renderOnChange();
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
        // A detection under an editing gesture is drawn live by the base
        // layers, so its hover or selection redraw would sit at the position
        // the gesture already left.
        isDetectionVisible: (detection) =>
          !resolveContextState(detection).hidden &&
          !isUnderEditingGesture(detection),
      })
    : undefined;
  let fastTranslatedDetectionId: string | number | null = null;
  const unsubscribeFastTranslate =
    options.editingEngine?.subscribeFastTranslate((id, dx, dy) => {
      fastTranslatedDetectionId = id;
      boxLayer.translateDetection(id, dx, dy);
      vectorLayer.translateDetection(id, dx, dy);
      regionLayer.translateDetection(id, dx, dy);
      labelLayer?.translateDetection(id, dx, dy);
      renderNow();
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
    regionLayer.translateDetection(id, 0, 0);
    labelLayer?.translateDetection(id, 0, 0);
    boxLayer.invalidateDetection(id);
    vectorLayer.invalidateDetection(id);
    boxLayer.drawFrame(currentMediaTime, viewportScale);
    vectorLayer.drawFrame(currentMediaTime, viewportScale);
    regionLayer.drawFrame(currentMediaTime, viewportScale);
    labelLayer?.drawFrame(currentMediaTime, viewportScale);
    renderNow();
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && interactionLayer) {
      interactionLayer.cycleSelection(event.shiftKey ? -1 : 1);
      event.preventDefault();
      drawInteractionPresentationLayer(currentMediaTime);
      drawAnnotationOverlay(currentMediaTime, overlayNow());
      renderOnChange();
      return;
    }

    options.editingEngine?.keyDown(event.key);
    drawAnnotationOverlay(currentMediaTime, overlayNow());
    renderOnChange();
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
        isDetectionVisible: (detection) =>
          !resolveContextState(detection).hidden,
      })
    : undefined;
  let mediaSprite: InstanceType<typeof Sprite> | undefined;
  let stagingTexture: PixiTexture | undefined;
  let stagingTextureSource: TextureUploadSource | undefined;
  const collectFrameTimings = options.diagnostics?.frameTimings === true;

  const syncSceneChildren = () => {
    syncPixiSceneLayerChildren(mediaScene, layerSlots);
  };

  const updateMediaSceneFit = () => {
    if (!mediaScene || mediaWidth <= 0 || mediaHeight <= 0) {
      syncPresentationBox();
      return;
    }

    const { height: screenHeight, width: screenWidth } = containerSize;

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

  /**
   * A canvas hands the compositor one damage rect: its whole box. A canvas
   * spanning the container therefore repaints the letterbox margin at present
   * rate, so the canvas is sized to the picture and positioned inside the
   * container, leaving the margin to the backdrop.
   *
   * The box follows the picture under pan and zoom rather than growing to the
   * container, so the margin keeps its exemption at every viewport transform.
   */
  const syncPresentationBox = () => {
    const { height: containerHeight, width: containerWidth } = containerSize;
    if (containerWidth <= 0 || containerHeight <= 0) return presentationBox;

    const transform = viewport.getTransform();
    const pictureScale = baseFit ? baseFit.scale * transform.scale : 0;
    const span = baseFit
      ? {
          left: Math.max(0, Math.floor(baseFit.x + transform.x)),
          top: Math.max(0, Math.floor(baseFit.y + transform.y)),
          right: Math.min(
            containerWidth,
            Math.ceil(baseFit.x + transform.x + mediaWidth * pictureScale),
          ),
          bottom: Math.min(
            containerHeight,
            Math.ceil(baseFit.y + transform.y + mediaHeight * pictureScale),
          ),
        }
      : { left: 0, top: 0, right: containerWidth, bottom: containerHeight };
    const next = {
      left: span.left,
      top: span.top,
      width: Math.max(1, span.right - span.left),
      height: Math.max(1, span.bottom - span.top),
    };

    if (
      next.left === presentationBox.left &&
      next.top === presentationBox.top &&
      next.width === presentationBox.width &&
      next.height === presentationBox.height &&
      presentationResolution === appliedResolution
    ) {
      return presentationBox;
    }

    presentationBox = next;
    appliedResolution = presentationResolution;
    rendererCanvas.style.left = `${next.left}px`;
    rendererCanvas.style.top = `${next.top}px`;
    app.renderer.resize(next.width, next.height, presentationResolution);
    return presentationBox;
  };

  const applyViewportTransform = () => {
    if (!mediaScene || !baseFit) return;
    const transform = viewport.getTransform();
    viewportScale = baseFit.scale * transform.scale;
    mediaScene.scale.set(viewportScale);
    const box = syncPresentationBox();
    mediaScene.position.set(
      baseFit.x + transform.x - box.left,
      baseFit.y + transform.y - box.top,
    );
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
    drawPolygonFrame(currentMediaTime);
    vectorLayer.drawFrame(currentMediaTime, viewportScale);
    labelLayer?.drawFrame(currentMediaTime, viewportScale);
    drawFocusLayer(currentMediaTime);
    drawInteractionPresentationLayer(currentMediaTime);
  };

  // Pixi's ResizePlugin listens to the window resize event, which does not
  // fire when an application drawer or split pane changes only this element's
  // dimensions. Resize Pixi and recompute the contain/cover transform in the
  // same observer callback so CSS cannot stretch an old canvas between frames.
  const disconnectContainerResizeObserver = observePixiContainerResize(
    options.container,
    () => {
      measureContainer();
      syncPresentationBox();
      updateMediaSceneFit();
      renderOnChange();
    },
  );

  measureContainer();
  syncPresentationBox();

  const drawAnnotationOverlayNow = () =>
    drawAnnotationOverlay(currentMediaTime, overlayNow());
  const tickFocusLayer = () => focusLayer?.tick(now());
  const handleVisibilityChange = () => {
    // A hidden tab loses its swapchain, and the configuration it comes back
    // with has nothing in it. Nothing about the scene changed, so only an
    // unconditional render puts the picture back.
    if (!document.hidden) renderScene();
  };

  let unsubscribeDetectionTimeline: (() => void) | undefined;

  if (frameChannel) {
    frameChannel.onPresentedFrame(handlePresentedFrame);
    document.addEventListener?.("visibilitychange", handleVisibilityChange);
    // A detection load landing moves what the window covers exactly as a cook
    // landing does. Nothing else brings that to a resting playhead: the layers
    // read the timeline only while drawing, and this is what makes the draw.
    unsubscribeDetectionTimeline = options.detectionTimeline.subscribe?.(
      handlePreparedWindowChange,
    );
  } else {
    app.ticker.add(updateMediaSceneFit);
    app.ticker.add(drawAnnotationOverlayNow);
    app.ticker.add(tickFocusLayer);
  }

  const uploadFrameToStagingCanvas = (frame: VideoFrame) => {
    stagingContext.drawImage(frame, 0, 0, mediaWidth, mediaHeight);
    stagingTextureSource?.update();
    stagingTexture?.update();
  };

  const framePresentTargets: FramePresentTargets = {
    adoptMediaTime(mediaTime) {
      currentMediaTime = mediaTime;
      hasPresentedSample = true;
      presentedFrameSerial += 1;
      drawnReadiness = annotationWindow.getReadinessToken(mediaTime);
    },
    completePresentation(mediaTime, boxState, regionState) {
      options.onPresentationUpdate?.(
        createPresentedSampleState(mediaTime, boxState, regionState),
      );
    },
    fitMediaScene: updateMediaSceneFit,
    layers: {
      advanceFocus: advanceFocusAnimation,
      drawAnnotationOverlay: (mediaTime) =>
        drawAnnotationOverlay(mediaTime, mediaTime * MILLISECONDS_PER_SECOND),
      drawBox: (mediaTime) => boxLayer.drawFrame(mediaTime, viewportScale),
      drawFocus: drawFocusLayer,
      drawInteraction: (mediaTime) => interactionLayer?.drawFrame(mediaTime),
      drawInteractionPresentation: drawInteractionPresentationLayer,
      drawLabel: (mediaTime) => labelLayer?.drawFrame(mediaTime, viewportScale),
      drawMask: drawMaskFrame,
      drawPolygon: drawPolygonFrame,
      drawRegion: (mediaTime) =>
        regionLayer.drawFrame(mediaTime, viewportScale),
      drawVector: (mediaTime) =>
        vectorLayer.drawFrame(mediaTime, viewportScale),
    },
    render: renderPresent,
    uploadFrame: (frame) => {
      mediaCompositor?.upload(frame);
      presentedSampleTimestamp = currentMediaTime;
    },
  };

  return {
    getRenderCount() {
      return frameChannel ? renderScheduler.getRenderCount() : null;
    },

    getPreparedAnnotationWindow() {
      return frameChannel ? annotationWindow.getSnapshot() : null;
    },

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
      regionSlot.setDisplay(regionLayer.createContainer());
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
      if (frameChannel) mediaCompositor = createSceneMediaCompositor();
    },

    setPlaybackActive(active) {
      isPlaybackActive = active;
      maskLayer?.setPlaybackActive(active);
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
        presentedFrameSerial += 1;

        if (!collectFrameTimings) {
          sample.draw(stagingContext, 0, 0, mediaWidth, mediaHeight);
          presentedSampleTimestamp = sample.timestamp;
          stagingTextureSource?.update();
          stagingTexture?.update();
          drawMaskFrame(sample.timestamp);
          const boxState = boxLayer.drawFrame(sample.timestamp, viewportScale);
          drawPolygonFrame(sample.timestamp);
          vectorLayer.drawFrame(sample.timestamp, viewportScale);
          const regionState = regionLayer.drawFrame(
            sample.timestamp,
            viewportScale,
          );
          interactionLayer?.drawFrame(sample.timestamp);
          drawFocusLayer(sample.timestamp);
          drawInteractionPresentationLayer(sample.timestamp);
          labelLayer?.drawFrame(sample.timestamp, viewportScale);
          updateMediaSceneFit();

          return {
            ...createPresentedSampleState(
              sample.timestamp,
              boxState,
              regionState,
            ),
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
          presentedSampleTimestamp = sample.timestamp;
          stagingTextureSource?.update();
          stagingTexture?.update();
        });
        maskMs = measure(() => {
          drawMaskFrame(sample.timestamp);
        });
        let boxState: PixiBoxLayerState | undefined;
        let regionState: PixiRegionLayerState | undefined;

        boxMs = measure(() => {
          boxState = boxLayer.drawFrame(sample.timestamp, viewportScale);
          drawPolygonFrame(sample.timestamp);
          vectorLayer.drawFrame(sample.timestamp, viewportScale);
          regionState = regionLayer.drawFrame(sample.timestamp, viewportScale);
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
          ...createPresentedSampleState(
            sample.timestamp,
            boxState,
            regionState,
          ),
          duration: sample.duration,
          renderTimings,
        };
      } finally {
        sample.close();
      }
    },

    captureFrame(captureOptions) {
      if (presentedSampleTimestamp === null) {
        return Promise.reject(
          new Error("No media frame has been presented yet."),
        );
      }

      return captureCanvasMediaFrame({
        capture: captureOptions,
        createCanvas: () => document.createElement("canvas"),
        mediaTime: presentedSampleTimestamp,
        source: readPresentedSurface(),
      });
    },

    waitForRenderPreparation(mediaTime, gateOptions) {
      return Promise.all([
        maskLayer?.waitForRenderPreparation(mediaTime, gateOptions),
        polygonLayer?.waitForRenderPreparation(mediaTime, gateOptions),
      ]).then(() => undefined);
    },

    setRenderQuality(maxDevicePixelRatio) {
      presentationResolution = resolvePixiResolution(maxDevicePixelRatio);
      syncPresentationBox();
      updateMediaSceneFit();
      renderOnChange();
    },

    setDisplayAdjustments(adjustments) {
      void import("pixi.js").then(({ ColorMatrixFilter }) => {
        const brightness = adjustments.brightness ?? 1;
        const contrast = adjustments.contrast ?? 1;
        const filter = new ColorMatrixFilter();
        filter.brightness(brightness, false);
        filter.contrast(contrast - 1, true);
        if (mediaSprite) mediaSprite.filters = [filter];
        displayBrightness = brightness;
        displayContrast = contrast;
        renderOnChange();
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
      renderOnChange();
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
      renderOnChange();
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
      renderOnChange();
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
      renderOnChange();
    },

    setPresentation(presentation, mediaTime) {
      appliedPresentation = presentation;
      currentMediaTime = mediaTime;
      if (presentation.backgroundColor !== undefined) {
        app.renderer.background.color = presentation.backgroundColor;
        applyBackdropColor(backdrop, presentation.backgroundColor);
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
        if (maskVisibilityChanged && (currentMaskStyle || currentFocusStyle)) {
          visibilityVersion += 1;
          syncMaskPreparation();
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
      if (
        presentation.boxCornerStyle !== undefined ||
        presentation.ellipseStyle !== undefined ||
        presentation.markerStyle !== undefined
      ) {
        if (presentation.boxCornerStyle !== undefined) {
          currentBoxCornerStyle = presentation.boxCornerStyle;
        }
        if (presentation.ellipseStyle !== undefined) {
          currentEllipseStyle = presentation.ellipseStyle;
        }
        if (presentation.markerStyle !== undefined) {
          currentMarkerStyle = presentation.markerStyle;
        }
        vectorLayer.setStyles({ shapeStyle: resolveVectorShapeStyle() });
      }

      currentRegionRenderers =
        presentation.renderers?.filter(
          (renderer): renderer is RegionAnnotationRenderer =>
            renderer.kind === "region",
        ) ?? [];
      const nextRegionMaskCoverageKey = resolveRegionMaskCoverageKey(
        currentRegionRenderers,
      );
      const regionMaskCoverageChanged =
        nextRegionMaskCoverageKey !== regionMaskCoverageKey;

      regionMaskCoverageKey = nextRegionMaskCoverageKey;
      regionLayer.setRenderers(currentRegionRenderers);

      if (
        presentation.maskStyle !== undefined ||
        presentation.maskHaloStyle !== undefined ||
        regionMaskCoverageChanged
      ) {
        if (presentation.maskStyle !== undefined) {
          currentMaskStyle = presentation.maskStyle;
        }

        if (presentation.maskHaloStyle !== undefined) {
          currentMaskHaloStyle = presentation.maskHaloStyle;
        }

        syncMaskPreparation();

        if (currentMaskStyle || currentMaskHaloStyle) {
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
        currentFocusStyle = presentation.focusStyle;
        const nextFocusLayer = presentation.focusStyle
          ? ensureFocusLayer(presentation.focusStyle)
          : focusLayer;

        nextFocusLayer?.setFocusStyle(presentation.focusStyle);
        syncMaskPreparation();

        if (presentation.focusStyle) {
          attachFocusLayerDisplay();
          syncSceneChildren();
        }
      }

      if (mediaWidth <= 0 || mediaHeight <= 0) {
        renderOnChange();
        return;
      }

      const { boxState, regionState } = drawAnnotationFrame(mediaTime);
      renderOnChange();

      return createPresentedSampleState(mediaTime, boxState, regionState);
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
      renderOnChange();

      return pick;
    },

    destroy() {
      isDestroyed = true;
      if (displayFrameHandle !== null) {
        cancelDisplayFrame(displayFrameHandle);
        displayFrameHandle = null;
      }
      unsubscribeDetectionTimeline?.();
      disconnectContainerResizeObserver();
      app.cancelResize?.();
      app.ticker.remove(updateMediaSceneFit);
      app.ticker.remove(drawAnnotationOverlayNow);
      app.ticker.remove(tickFocusLayer);
      document.removeEventListener?.(
        "visibilitychange",
        handleVisibilityChange,
      );
      // Registering replaces the consumer, which is the only way to stop being
      // one. A frame that arrives after this still has to be closed, or it pins
      // a decoder buffer in a producer that outlives the scene.
      frameChannel?.onPresentedFrame((presented) => presented.frame.close());
      mediaCompositor?.destroy();
      interactionLayer?.destroy();
      interactionPresentationLayer?.destroy();
      focusLayer?.destroy();
      maskLayer?.destroy();
      polygonLayer?.destroy();
      labelLayer?.destroy();
      vectorLayer.destroy();
      regionLayer.destroy();
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
    regionState?: PixiRegionLayerState,
  ): PresentedMediaSample {
    const detectionFrame = annotationDetectionTimeline.selectFrame(mediaTime);

    return {
      activeDetectionCount: countPresentedDetections(
        detectionFrame,
        mediaTime,
        boxState,
        regionState,
      ),
      activeDetectionFrameIndex: detectionFrame?.frameIndex ?? null,
      activeDetectionFrameTime: detectionFrame?.mediaTime ?? null,
      detectionBuffer: options.detectionTimeline.getState(),
      mediaTime,
      presentedFrameSerial,
    };
  }

  function countPresentedDetections(
    frame: DetectionFrame | undefined,
    mediaTime: number,
    boxState: PixiBoxLayerState,
    regionState?: PixiRegionLayerState,
  ) {
    if (!frame) {
      return 0;
    }

    const visibleDetectionIndexes = new Set(boxState.activeDetectionIndexes);
    for (const detectionIndex of regionState?.activeDetectionIndexes ?? []) {
      visibleDetectionIndexes.add(detectionIndex);
    }

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

  function ensureMaskLayer(preparationStyle: MaskStyle) {
    if (!maskLayer) {
      maskLayer = createPixiMaskLayer({
        BlurFilter,
        BufferImageSource,
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Rectangle,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        acceptsUnalignedTextureRows,
        detectionTimeline: options.detectionTimeline,
        maskHaloStyle: resolveVisibilityMaskHaloStyle(),
        maskStyle: preparationStyle,
        onPreparedWindowChange: handlePreparedWindowChange,
        renderPreparation: options.renderPreparation,
        resolveInstructions: resolveArtifactMaskInstructions,
      });

      maskLayer.setPlaybackActive(isPlaybackActive);

      if (timelineContext) {
        maskLayer.setTimelineContext(timelineContext);
      }
    }

    return maskLayer;
  }

  /**
   * The id-mask artifact is what the focus cutout samples as well as what the
   * mask fill draws, so preparation has to keep running while either one is on.
   */
  function resolveMaskPreparationStyle() {
    const baseStyle =
      currentMaskStyle ??
      (currentMaskHaloStyle ? HALO_ONLY_MASK_STYLE : null) ??
      (currentFocusStyle ? ID_MASK_PREPARATION_STYLE : null) ??
      (regionMaskCoverageKey ? REGION_COVERAGE_ONLY_MASK_STYLE : null);

    if (!baseStyle) {
      return null;
    }

    return createVisibilityMaskStyle(
      regionMaskCoverageKey
        ? keyArtifactByRegionCoverage(baseStyle)
        : baseStyle,
    );
  }

  function syncMaskPreparation() {
    const preparationStyle = resolveMaskPreparationStyle();

    if (!preparationStyle) {
      maskLayer?.setFillVisible(false);
      maskLayer?.setMaskStyle(null);
      maskLayer?.setMaskHaloStyle(null);
      return;
    }

    const layer = ensureMaskLayer(preparationStyle);

    layer.setFillVisible(currentMaskStyle !== null);
    layer.setMaskStyle(preparationStyle);
    layer.setMaskHaloStyle(resolveVisibilityMaskHaloStyle());
  }

  /**
   * Which targets crop to their own mask, as the identity the prepared
   * artifact is keyed by: changing that set has to invalidate frames cooked
   * for the previous one, and the coverage planes are not part of the style.
   */
  function resolveRegionMaskCoverageKey(
    renderers: readonly RegionAnnotationRenderer[],
  ) {
    const exactTargets = renderers
      .filter(usesExactMaskCoverage)
      .map(({ target }) => ({
        className: target.className,
        id: target.id,
        sourceId: target.sourceId,
      }));

    return exactTargets.length > 0 ? JSON.stringify(exactTargets) : "";
  }

  function keyArtifactByRegionCoverage(style: MaskStyle): MaskStyle {
    if (
      regionCoverageStyleCache?.source === style &&
      regionCoverageStyleCache.key === regionMaskCoverageKey
    ) {
      return regionCoverageStyleCache.style;
    }

    const keyedStyle: MaskStyle = {
      ...style,
      artifactKey:
        style.artifactKey === undefined
          ? undefined
          : `${style.artifactKey}:region-coverage:${regionMaskCoverageKey}`,
    };

    regionCoverageStyleCache = {
      key: regionMaskCoverageKey,
      source: style,
      style: keyedStyle,
    };

    return keyedStyle;
  }

  function usesExactMaskCoverage(renderer: RegionAnnotationRenderer) {
    return (
      renderer.source.kind === RegionRendererSourceKind.Media &&
      renderer.source.coverage?.kind === RegionRendererCoverageKind.Mask
    );
  }

  function matchesStaticRegionTarget(
    target: RegionRendererTarget,
    detection: Detection,
  ) {
    return (
      matchesStaticTargetValue(target.id, detection.id) &&
      matchesStaticTargetValue(target.className, detection.className) &&
      matchesStaticTargetValue(target.sourceId, detection.sourceId)
    );
  }

  function matchesStaticTargetValue(
    configured: string | number | readonly (string | number)[] | undefined,
    actual: string | number | undefined,
  ) {
    if (configured === undefined) {
      return true;
    }

    if (actual === undefined) {
      return false;
    }

    return Array.isArray(configured)
      ? configured.some((value) => value === actual)
      : configured === actual;
  }

  /**
   * Coverage rides on the same prepared frame as the visible masks, so a
   * target that crops to its own mask without drawing one still needs an
   * instruction. That instruction says it is invisible, and the compositor
   * keeps it out of both the composite and the id raster.
   */
  function resolveArtifactMaskInstructions(instructionOptions: {
    readonly frame: DetectionFrame;
    readonly maskStyle: MaskStyle;
    readonly mediaTime: number;
  }) {
    const instructions: SerializableMaskInstruction[] = [];
    const exactRegionRenderers = currentRegionRenderers.filter(
      usesExactMaskCoverage,
    );
    const orderedDetections = instructionOptions.frame.detections
      .map((detection, detectionIndex) => ({ detection, detectionIndex }))
      .sort(
        (left, right) =>
          (left.detection.zIndex ?? left.detectionIndex) -
          (right.detection.zIndex ?? right.detectionIndex),
      );

    for (const { detection, detectionIndex } of orderedDetections) {
      const visibleInstruction = instructionOptions.maskStyle.resolve(
        detection,
        {
          detectionIndex,
          frame: instructionOptions.frame,
          mediaTime: instructionOptions.mediaTime,
        },
      );
      const regionCoverageMask =
        detection.mask &&
        !resolveContextState(detection).hidden &&
        exactRegionRenderers.some((renderer) =>
          matchesStaticRegionTarget(renderer.target, detection),
        )
          ? detection.mask
          : undefined;

      if (!visibleInstruction && !regionCoverageMask) {
        continue;
      }

      instructions.push({
        ...(visibleInstruction ?? {
          alpha: 0,
          color: 0,
          mask: regionCoverageMask!,
          visible: false,
        }),
        detectionIndex,
        regionCoverageMask,
      });
    }

    return instructions;
  }

  function resolveVisibilityMaskHaloStyle(): MaskHaloStyle | null {
    const style = currentMaskHaloStyle;

    if (!style) {
      return null;
    }

    return {
      resolve(detection, context) {
        const state = resolveContextState(detection);

        if (state.hidden) {
          return undefined;
        }

        return style.resolve(detection, { ...context, ...state });
      },
    };
  }

  /**
   * The vector layer takes one shape style, and the ellipse, marker and
   * box-corner renderer kinds all lower to shape instructions, so they are
   * composed onto whatever style the caller passed.
   */
  function resolveVectorShapeStyle(): ShapeStyle | null {
    const kindShapeStyle = resolveAnnotationShapeStyle({
      boxCornerStyle: currentBoxCornerStyle,
      ellipseStyle: currentEllipseStyle,
      markerStyle: currentMarkerStyle,
    });
    const baseShapeStyle = options.shapeStyle ?? null;

    if (!kindShapeStyle || !baseShapeStyle) {
      return kindShapeStyle ?? baseShapeStyle;
    }

    return {
      resolve(detection, context) {
        const combined = [
          ...(baseShapeStyle.resolve(detection, context) ?? []),
          ...(kindShapeStyle.resolve(detection, context) ?? []),
        ];

        return combined.length > 0 ? combined : undefined;
      },
    };
  }

  function ensurePolygonLayer(polygonStyle: PolygonStyle) {
    if (options.editingEngine) {
      return undefined;
    }

    if (!polygonLayer) {
      polygonLayer = createPixiPolygonLayer({
        BufferImageSource,
        Container,
        ImageSource,
        Mesh,
        MeshGeometry,
        Shader,
        Sprite,
        Texture,
        UniformGroup,
        acceptsUnalignedTextureRows,
        detectionTimeline: options.detectionTimeline,
        onPreparedWindowChange: handlePreparedWindowChange,
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
        isDetectionVisible: (detection) =>
          !resolveContextState(detection).hidden,
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
      editingKind === AnnotationGestureStateKind.DragSelecting ||
      isFocusArtifactOwed(mediaTime)
    ) {
      focusLayer.drawFrame({
        frame: undefined,
        hoveredPick: null,
        mediaTime,
        selectedPick: null,
      });
      return;
    }

    const frame = annotationDetectionTimeline.selectFrame(mediaTime);

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

    const frame = annotationDetectionTimeline.selectFrame(mediaTime);
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

  /**
   * A cook landed, so what the window covers may have moved. A result for a
   * frame that is not on screen stays in the window; a window that reaches the
   * frame on screen gets there as a redraw of that frame, which is the only way
   * anything a cook produced is ever drawn.
   */
  function handlePreparedWindowChange() {
    if (isPresenting || isDestroyed) {
      return;
    }

    if (
      annotationWindow.getReadinessToken(currentMediaTime) === drawnReadiness
    ) {
      return;
    }

    const { boxState, regionState } = drawAnnotationFrame(currentMediaTime);

    if (
      !frameChannel ||
      !renderScheduler.renderOnChange(describeSceneRender())
    ) {
      return;
    }

    options.onPresentationUpdate?.(
      createPresentedSampleState(currentMediaTime, boxState, regionState),
    );
  }

  function drawAnnotationFrame(mediaTime: number) {
    drawnReadiness = annotationWindow.getReadinessToken(mediaTime);

    drawMaskFrame(mediaTime);
    const boxState = boxLayer.drawFrame(mediaTime, viewportScale);
    drawPolygonFrame(mediaTime);
    vectorLayer.drawFrame(mediaTime, viewportScale);
    const regionState = regionLayer.drawFrame(mediaTime, viewportScale);
    interactionLayer?.drawFrame(mediaTime);
    drawFocusLayer(mediaTime);
    drawInteractionPresentationLayer(mediaTime);
    labelLayer?.drawFrame(mediaTime, viewportScale);

    return { boxState, regionState };
  }

  /**
   * Drawing an uncovered frame is drawing nothing, and the cook still has to be
   * pointed at it or the window would never reach it.
   */
  function drawMaskFrame(mediaTime: number) {
    if (!maskLayer) {
      return;
    }

    if (isFramePrepared(mediaTime)) {
      maskLayer.drawFrame(mediaTime);
      return;
    }

    maskLayer.clearFrame();
    maskLayer.prepareFrame(mediaTime);
  }

  function drawPolygonFrame(mediaTime: number) {
    if (!polygonLayer) {
      return;
    }

    if (isFramePrepared(mediaTime)) {
      polygonLayer.drawFrame(mediaTime, viewportScale);
      return;
    }

    polygonLayer.clearFrame();
    polygonLayer.prepareFrame(mediaTime, viewportScale);
  }

  function isFramePrepared(mediaTime: number) {
    return (
      !frameChannel || annotationWindow.getPreparedFrame(mediaTime) !== null
    );
  }

  /**
   * Focus reads the id raster the mask cook produces. While that cook is owed,
   * the vector outline focus falls back to costs more than the frame budget
   * holds, for a picture the cooked raster supersedes a frame later.
   */
  function isFocusArtifactOwed(mediaTime: number) {
    return maskLayer !== undefined && !maskLayer.isArtifactPrepared(mediaTime);
  }

  function drawAnnotationOverlay(mediaTime: number, overlayNowMs: number) {
    const frame = annotationDetectionTimeline.selectFrame(mediaTime);
    const interactionState = interactionLayer?.getState();
    const editingState = options.editingEngine?.getState();
    labelLayer?.drawCreationPreview(
      editingState?.kind === AnnotationGestureStateKind.Creating
        ? editingState.preview
        : null,
      mediaTime,
      viewportScale,
    );
    annotationOverlayLayer.draw({
      frame,
      marquee: interactionState?.marqueeRect ?? null,
      mediaHeight,
      mediaWidth,
      now: overlayNowMs,
      pointer: interactionState?.pointerPoint ?? null,
      previewOverlay: options.previewOverlay?.() ?? null,
      selectedDetectionIds: (interactionState?.selectedPicks ?? []).flatMap(
        ({ detection }) => (detection.id === undefined ? [] : [detection.id]),
      ),
      viewportScale,
      visibility: currentVisibility,
    });
  }

  /**
   * Milliseconds for animations that are not annotation geometry. A pull scene
   * has a ticker and reads the wall clock; a push scene has the presented media
   * time and nothing else, so its animations move only when the media does.
   */
  function overlayNow() {
    return frameChannel ? currentMediaTime * MILLISECONDS_PER_SECOND : now();
  }

  function handlePresentedFrame(presented: PresentedVideoFrame) {
    if (!mediaCompositor) {
      presented.frame.close();
      return;
    }

    // Scheduling a cook notifies, and a notification that drew or rendered
    // here would put a second render inside one present.
    isPresenting = true;

    try {
      presentVideoFrame(presented, framePresentTargets);
    } finally {
      isPresenting = false;
    }
  }

  function advanceFocusAnimation(mediaTime: number) {
    if (!focusLayer) return;

    const mediaTimeMs = mediaTime * MILLISECONDS_PER_SECOND;

    if (focusAnimationMediaTimeMs !== null) {
      focusAnimationTimeMs += Math.abs(mediaTimeMs - focusAnimationMediaTimeMs);
    }

    focusAnimationMediaTimeMs = mediaTimeMs;
    focusLayer.tick(focusAnimationTimeMs);
  }

  function settleFocusAnimation() {
    if (!focusLayer) return;

    focusAnimationTimeMs += STATIC_FOCUS_SETTLE_MS;
    focusLayer.tick(focusAnimationTimeMs);
  }

  function renderScene() {
    renderScheduler.render(describeSceneRender());
  }

  /**
   * Renders a present at most once per display refresh. Frames arrive as
   * messages from the producer's own thread, so a main thread that falls
   * behind takes a whole burst in one refresh and submits a scene per frame
   * that only the last of can reach the screen. Deferring costs no latency:
   * the skipped render is replaced before the refresh it would have made.
   */
  function renderPresent() {
    if (displayFrameHandle !== null) {
      hasDeferredPresentRender = true;
      return;
    }

    renderScene();
    displayFrameHandle = requestDisplayFrame(flushDeferredPresentRender);
  }

  function flushDeferredPresentRender() {
    displayFrameHandle = null;

    if (!hasDeferredPresentRender || isDestroyed) {
      return;
    }

    hasDeferredPresentRender = false;
    renderScene();
    displayFrameHandle = requestDisplayFrame(flushDeferredPresentRender);
  }

  function renderNow() {
    if (frameChannel) renderScene();
  }

  function renderOnChange() {
    if (!frameChannel) return;

    settleFocusAnimation();
    renderScheduler.renderOnChange(describeSceneRender());
  }

  /**
   * Everything a render would put on screen, as values that can be compared.
   * Styles are opaque resolvers, so they are compared by identity: handing the
   * scene a new style object is the only signal it has that styling changed.
   */
  function describeSceneRender(): SceneRenderSignature {
    const interactionState = interactionLayer?.getState();
    const transform = viewport.getTransform();

    return [
      presentedFrameSerial,
      currentMediaTime,
      annotationWindow.getReadinessToken(currentMediaTime),
      viewportScale,
      baseFit?.x,
      baseFit?.y,
      transform.scale,
      transform.x,
      transform.y,
      app.screen.width,
      app.screen.height,
      app.renderer.resolution,
      displayBrightness,
      displayContrast,
      appliedPresentation?.backgroundColor,
      appliedPresentation?.annotationOverlayStyle,
      appliedPresentation?.boxStyle,
      appliedPresentation?.focusStyle,
      appliedPresentation?.interactionStyle,
      appliedPresentation?.keypointStyle,
      appliedPresentation?.labelStyle,
      appliedPresentation?.maskStyle,
      appliedPresentation?.polygonStyle,
      appliedPresentation?.polylineStyle,
      appliedPresentation?.renderers,
      appliedPresentation?.visibility,
      currentMaskStyle?.opacity,
      visibilityVersion,
      interactionState?.hoveredPick?.detection,
      interactionState?.hoveredPick?.detectionIndex,
      interactionState?.selectedPick?.detection,
      interactionState?.selectedPick?.detectionIndex,
      interactionState?.selectedPicks,
      interactionState?.marqueeRect,
      options.editingEngine?.getState(),
      options.editingEngine ? interactionState?.pointerPoint : null,
    ];
  }

  /**
   * Puts presented pixels on the media sprite. WebGPU takes the decoded frame
   * straight into a texture Pixi samples; anywhere else the frame goes through
   * the staging canvas the pull path already uses.
   */
  function createSceneMediaCompositor(): MediaCompositor {
    const device = (
      app.renderer as { readonly gpu?: { readonly device?: GPUDevice } }
    ).gpu?.device;
    const sprite = mediaSprite;

    if (!device || !sprite) {
      return { destroy: () => undefined, upload: uploadFrameToStagingCanvas };
    }

    // Extract through a detached stand-in sprite: the scene's media sprite
    // carries the contain-fit transform, which bakes display scaling into a
    // media-sized canvas, and the GPU-external texture reads back black when
    // extracted directly. A parentless sprite at media size reads the frame
    // one-to-one, matching what the staging canvas holds on the other path.
    readPresentedSurface = () => {
      const detached: InstanceType<typeof Sprite> = new Sprite({
        texture: sprite.texture,
      });
      detached.width = mediaWidth;
      detached.height = mediaHeight;
      try {
        return app.renderer.extract.canvas(
          detached,
        ) as unknown as HTMLCanvasElement;
      } finally {
        detached.destroy();
      }
    };

    return createMediaCompositor({
      attach: (texture) => {
        const externalSource: PixiExternalSource = new pixi.ExternalSource({
          renderer: app.renderer,
          resource: texture,
        });

        // A decode of another size resizes this source in place, and only a
        // dynamic texture forwards that to the sprite. Without it the sprite
        // takes the new size's scale while still drawing the previous size's
        // quad, so a preview-sized frame paints the media oversized.
        sprite.texture = new Texture({ dynamic: true, source: externalSource });
        sizeMediaSprite();
        return externalSource;
      },
      device,
      height: mediaHeight,
      onTextureReplaced: sizeMediaSprite,
      width: mediaWidth,
    });
  }

  /**
   * The media sprite covers the media's own dimensions whatever the decode
   * delivers, so annotations keep drawing in media coordinates at canvas
   * resolution instead of inheriting the texture's size.
   */
  function sizeMediaSprite() {
    if (!mediaSprite) return;

    mediaSprite.width = mediaWidth;
    mediaSprite.height = mediaHeight;
  }

  function ensureLabelLayer(
    labelStyle: NonNullable<typeof options.labelStyle>,
  ) {
    if (!labelLayer) {
      labelLayer = createPixiLabelLayer({
        Container,
        Graphics,
        Text,
        detectionTimeline: annotationDetectionTimeline,
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

  function isUnderEditingGesture(detection: Detection) {
    const state = options.editingEngine?.getState();

    return (
      state !== undefined &&
      (state.kind === AnnotationGestureStateKind.Moving ||
        state.kind === AnnotationGestureStateKind.Resizing) &&
      state.preview !== null &&
      detection.id !== undefined &&
      state.activeDetectionId === detection.id
    );
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

/**
 * Copies presented frames into a GPU texture Pixi samples, with no CPU readback
 * in between. A decode whose size changed gets a new texture, and the swap is
 * all-or-nothing: exactly one of the two textures survives it.
 */
export function createMediaCompositor(
  options: MediaCompositorOptions,
): MediaCompositor {
  const { device } = options;
  let gpuTexture = createFrameTexture(device, options.width, options.height);
  const textureSource = options.attach(gpuTexture);

  return {
    destroy() {
      gpuTexture.destroy();
    },

    upload(frame) {
      const width = frame.displayWidth;
      const height = frame.displayHeight;

      if (width !== gpuTexture.width || height !== gpuTexture.height) {
        const replacement = createFrameTexture(device, width, height);

        try {
          textureSource.updateGPUTexture(replacement);
        } catch (error) {
          // A source that refused the swap is still sampling the texture on
          // screen, so the replacement is the one nothing is left holding.
          replacement.destroy();
          throw error;
        }

        gpuTexture.destroy();
        gpuTexture = replacement;
        options.onTextureReplaced();
      }

      device.queue.copyExternalImageToTexture(
        { source: frame },
        { texture: gpuTexture },
        { height, width },
      );
    },
  };
}

function createFrameTexture(device: GPUDevice, width: number, height: number) {
  return device.createTexture({
    format: "rgba8unorm",
    size: { height, width },
    usage:
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING,
  });
}

/** The next display refresh, or null where there is no animation frame. */
function requestDisplayFrame(callback: () => void): number | null {
  return typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame(callback)
    : null;
}

function cancelDisplayFrame(handle: number) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
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

/**
 * Fills the container and paints the margin around the canvas in the colour the
 * renderer clears to. The scene owns this element so the canvas is positioned
 * against a box it controls, whatever CSS the host puts on the container.
 */
function createSceneBackdrop(backgroundColor: number | undefined) {
  const backdrop = document.createElement("div");
  backdrop.style.height = "100%";
  backdrop.style.overflow = "hidden";
  backdrop.style.position = "relative";
  backdrop.style.width = "100%";
  applyBackdropColor(backdrop, backgroundColor);
  return backdrop;
}

function applyBackdropColor(
  backdrop: HTMLElement,
  backgroundColor: number | undefined,
) {
  const color = (backgroundColor ?? 0x111111) >>> 0;
  backdrop.style.backgroundColor = `#${color.toString(16).padStart(6, "0")}`;
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
