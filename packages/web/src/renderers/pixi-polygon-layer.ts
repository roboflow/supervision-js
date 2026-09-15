import type { SerializableMaskInstruction } from "#render-preparation/mask-preparation-worker-protocol";
import { RenderPreparationArtifactKind } from "#types/render-preparation";
import {
  BoxStrokeAlignment,
  type AnnotationStyleContext,
  type Detection,
  type DetectionFrame,
  type MaskStyle,
  type PolygonDrawInstruction,
  type PolygonStyle,
} from "supervision-js-core";
import { resolveScreenLength } from "./pixi-path";
import {
  createPixiMaskLayer,
  type BufferImageSourceConstructor,
  type PixiMaskLayer,
} from "./pixi-mask-layer";

type PixiMaskLayerOptions = Parameters<typeof createPixiMaskLayer>[0];

export interface PixiPolygonLayer {
  createDisplay(dimensions: {
    readonly height: number;
    readonly width: number;
  }): ReturnType<PixiMaskLayer["createSprite"]>;
  drawFrame(mediaTime: number, viewportScale?: number): void;
  prepareFrame(mediaTime: number, viewportScale?: number): void;
  clearFrame: PixiMaskLayer["clearFrame"];
  isArtifactPrepared: PixiMaskLayer["isArtifactPrepared"];
  getPreparationProgress: PixiMaskLayer["getPreparationProgress"];
  needsRenderPreparationWait: PixiMaskLayer["needsRenderPreparationWait"];
  getVectorFallbackStyle(): PolygonStyle;
  setPolygonStyle(polygonStyle: PolygonStyle | null | undefined): void;
  setTimelineContext: PixiMaskLayer["setTimelineContext"];
  waitForRenderPreparation: PixiMaskLayer["waitForRenderPreparation"];
  destroy(): void;
}

export function createPixiPolygonLayer(
  options: Omit<
    PixiMaskLayerOptions,
    "BufferImageSource" | "artifactKind" | "maskStyle" | "resolveInstructions"
  > & {
    /** Without it a frame that cooked to an id raster reaches no texture. */
    readonly BufferImageSource: BufferImageSourceConstructor;
    readonly polygonStyle: PolygonStyle;
    readonly resolveContextState?: (
      detection: Detection,
    ) => Partial<AnnotationStyleContext>;
  },
): PixiPolygonLayer {
  let mediaHeight = 0;
  let mediaWidth = 0;
  let polygonStyle: PolygonStyle | null = options.polygonStyle;
  let styleVersion = 0;
  let viewportScale = 1;
  const rasterLayer = createPixiMaskLayer({
    ...options,
    artifactKind: RenderPreparationArtifactKind.PolygonFrame,
    maskStyle: createArtifactStyle(),
    resolveInstructions: ({ frame, mediaTime }) =>
      polygonStyle
        ? resolvePreparedPolygonInstructions({
            frame,
            mediaHeight,
            mediaTime,
            mediaWidth,
            polygonStyle,
            resolveContextState: options.resolveContextState,
            viewportScale,
          })
        : [],
  });
  const vectorFallbackStyle: PolygonStyle = {
    resolve(detection, context) {
      const instruction = polygonStyle?.resolve(detection, context);

      return instruction && !canPreparePolygonInstruction(instruction)
        ? instruction
        : undefined;
    },
  };

  return {
    createDisplay(dimensions) {
      mediaHeight = dimensions.height;
      mediaWidth = dimensions.width;

      return rasterLayer.createSprite(dimensions);
    },

    destroy() {
      rasterLayer.destroy();
    },

    drawFrame(mediaTime, nextViewportScale = 1) {
      adoptViewportScale(nextViewportScale);
      rasterLayer.drawFrame(mediaTime);
    },

    prepareFrame(mediaTime, nextViewportScale = 1) {
      adoptViewportScale(nextViewportScale);
      rasterLayer.prepareFrame(mediaTime);
    },

    clearFrame: rasterLayer.clearFrame,

    isArtifactPrepared: rasterLayer.isArtifactPrepared,

    getPreparationProgress: rasterLayer.getPreparationProgress,

    getVectorFallbackStyle() {
      return vectorFallbackStyle;
    },

    setPolygonStyle(nextPolygonStyle) {
      if (nextPolygonStyle === undefined) {
        return;
      }

      polygonStyle = nextPolygonStyle;
      styleVersion += 1;
      rasterLayer.setMaskStyle(
        nextPolygonStyle ? createArtifactStyle() : nextPolygonStyle,
      );
    },

    needsRenderPreparationWait: rasterLayer.needsRenderPreparationWait,
    setTimelineContext: rasterLayer.setTimelineContext,
    waitForRenderPreparation: rasterLayer.waitForRenderPreparation,
  };

  function adoptViewportScale(nextViewportScale: number) {
    const normalizedViewportScale = Math.max(nextViewportScale, Number.EPSILON);

    if (normalizedViewportScale === viewportScale) {
      return;
    }

    viewportScale = normalizedViewportScale;
    styleVersion += 1;
    rasterLayer.setMaskStyle(createArtifactStyle());
  }

  function createArtifactStyle(): MaskStyle {
    return {
      artifactKey: [
        "polygon-frame",
        styleVersion,
        mediaWidth,
        mediaHeight,
        viewportScale,
      ].join(":"),
      opacity: 1,
      resolve: () => undefined,
    };
  }
}

export function canPreparePolygonInstruction(
  instruction: PolygonDrawInstruction,
) {
  const stroke = instruction.stroke;

  return (
    instruction.points.length >= 3 &&
    Boolean(instruction.fill || stroke) &&
    !stroke?.dash?.length &&
    stroke?.cap === undefined &&
    stroke?.join === undefined &&
    stroke?.miterLimit === undefined &&
    (stroke?.alignment === undefined ||
      stroke.alignment === BoxStrokeAlignment.Center)
  );
}

export function resolvePreparedPolygonInstructions(options: {
  readonly frame: DetectionFrame;
  readonly mediaHeight: number;
  readonly mediaTime: number;
  readonly mediaWidth: number;
  readonly polygonStyle: PolygonStyle;
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
  readonly viewportScale: number;
}): readonly SerializableMaskInstruction[] {
  if (options.mediaWidth <= 0 || options.mediaHeight <= 0) {
    return [];
  }

  const instructions: SerializableMaskInstruction[] = [];
  const orderedDetections = options.frame.detections
    .map((detection, detectionIndex) => ({ detection, detectionIndex }))
    .sort(
      (left, right) =>
        (left.detection.zIndex ?? left.detectionIndex) -
        (right.detection.zIndex ?? right.detectionIndex),
    );

  for (const { detection, detectionIndex } of orderedDetections) {
    const instruction = options.polygonStyle.resolve(detection, {
      detectionIndex,
      frame: options.frame,
      mediaTime: options.mediaTime,
      viewportScale: options.viewportScale,
      ...options.resolveContextState?.(detection),
    });

    if (!instruction || !canPreparePolygonInstruction(instruction)) {
      continue;
    }

    instructions.push({
      alpha: instruction.fill?.alpha ?? 0,
      color: instruction.fill?.color ?? 0,
      detectionIndex,
      polygon: {
        height: options.mediaHeight,
        points: instruction.points,
        width: options.mediaWidth,
      },
      stroke: instruction.stroke
        ? {
            alpha: instruction.stroke.alpha,
            color: instruction.stroke.color,
            width: resolveScreenLength(
              instruction.stroke.width,
              options.viewportScale,
            ),
          }
        : undefined,
    });
  }

  return instructions;
}
