import type { DetectionFrame } from "supervision";
import type { DemoPresentationSettings } from "./presentation/demo-presentation";

const BASKETBALL_TRACE_CLASS_NAME = "basketball";
const BASKETBALL_TRACE_TRACK_ID = "basketball-track:0";

export const docsVisualizationLayerIds = [
  "boxes",
  "masks",
  "labels",
  "polygons",
  "polylines",
  "keypoints",
] as const;

export type DocsVisualizationLayerId =
  (typeof docsVisualizationLayerIds)[number];

export interface DocsVisualizationLayerControl {
  readonly key: NumericPresentationSetting;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly step: number;
  readonly unit: "percent" | "pixels";
}

export interface DocsVisualizationLayerDefinition {
  readonly controls: readonly DocsVisualizationLayerControl[];
  readonly description: string;
  readonly title: string;
}

export type NumericPresentationSetting = {
  [
    Key in keyof DemoPresentationSettings
  ]: DemoPresentationSettings[Key] extends number ? Key : never;
}[keyof DemoPresentationSettings];

export const docsVisualizationLayers: Readonly<
  Record<DocsVisualizationLayerId, DocsVisualizationLayerDefinition>
> = {
  boxes: {
    controls: [
      {
        key: "boxFillAlpha",
        label: "Fill opacity",
        max: 0.5,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
      {
        key: "boxStrokeWidth",
        label: "Stroke width",
        max: 8,
        min: 1,
        step: 1,
        unit: "pixels",
      },
      {
        key: "boxCornerRadius",
        label: "Corner radius",
        max: 24,
        min: 0,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Axis-aligned detection bounds",
    title: "Boxes",
  },
  masks: {
    controls: [
      {
        key: "maskOpacity",
        label: "Layer opacity",
        max: 1,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
      {
        key: "maskFillAlpha",
        label: "Fill opacity",
        max: 1,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
      {
        key: "maskStrokeWidth",
        label: "Border width",
        max: 8,
        min: 0,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Compressed RLE segmentation",
    title: "Masks",
  },
  labels: {
    controls: [
      {
        key: "labelBackgroundAlpha",
        label: "Background opacity",
        max: 1,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
      {
        key: "labelFontSize",
        label: "Font size",
        max: 24,
        min: 10,
        step: 1,
        unit: "pixels",
      },
      {
        key: "labelCornerRadius",
        label: "Corner radius",
        max: 16,
        min: 0,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Class names and confidence",
    title: "Labels",
  },
  polygons: {
    controls: [
      {
        key: "polygonFillAlpha",
        label: "Fill opacity",
        max: 0.6,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
      {
        key: "polygonStrokeWidth",
        label: "Stroke width",
        max: 8,
        min: 1,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Closed media-space paths",
    title: "Polygons",
  },
  polylines: {
    controls: [
      {
        key: "polylineStrokeWidth",
        label: "Stroke width",
        max: 10,
        min: 1,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Basketball mask with its center-point trajectory",
    title: "Polylines",
  },
  keypoints: {
    controls: [
      {
        key: "keypointRadius",
        label: "Point radius",
        max: 12,
        min: 1,
        step: 0.5,
        unit: "pixels",
      },
      {
        key: "keypointEdgeWidth",
        label: "Skeleton width",
        max: 8,
        min: 1,
        step: 0.5,
        unit: "pixels",
      },
    ],
    description: "Pose markers and skeleton edges",
    title: "Keypoints & Skeletons",
  },
};

export function parseDocsVisualizationLayer(
  value: string | null,
): DocsVisualizationLayerId {
  return docsVisualizationLayerIds.includes(value as DocsVisualizationLayerId)
    ? (value as DocsVisualizationLayerId)
    : "boxes";
}

export function createDocsVisualizationLayerPresentation(
  layer: DocsVisualizationLayerId,
): Partial<DemoPresentationSettings> {
  return {
    boxesEnabled: layer === "boxes",
    focusEnabled: false,
    keypointsEnabled: layer === "keypoints",
    labelsEnabled: layer === "labels",
    masksEnabled: layer === "masks" || layer === "polylines",
    polygonsEnabled: layer === "polygons",
    polylinesEnabled: layer === "polylines",
    maskFillAlpha: 1,
    maskOpacity: 0.72,
  };
}

/**
 * The polyline page scopes the committed basketball fixture to its one
 * explicitly derived trace. This only selects frozen semantic detections; it
 * never adds or synthesizes geometry in the docs runtime.
 */
export function filterDocsVisualizationLayerFrames(
  layer: DocsVisualizationLayerId,
  frames: readonly DetectionFrame[],
): readonly DetectionFrame[] {
  if (layer !== "polylines") return frames;

  return frames.map((frame) => ({
    ...frame,
    detections: frame.detections.filter(
      (detection) =>
        detection.className === BASKETBALL_TRACE_CLASS_NAME &&
        detection.metadata?.trajectoryTrackId === BASKETBALL_TRACE_TRACK_ID,
    ),
  }));
}

export function createDocsVisualizationLayerSnippet(
  layer: DocsVisualizationLayerId,
  settings: DemoPresentationSettings,
) {
  switch (layer) {
    case "boxes":
      return `session.setPresentation({
  boxStyle: new BaseBoxStyle({
    cornerRadius: ${formatNumber(settings.boxCornerRadius)},
    fill: { alpha: ${formatNumber(settings.boxFillAlpha)} },
    stroke: { width: ${formatNumber(settings.boxStrokeWidth)} },
  }),
});`;
    case "masks":
      return `session.setPresentation({
  maskStyle: new BaseMaskStyle({
    fillAlpha: ${formatNumber(settings.maskFillAlpha)},
    opacity: ${formatNumber(settings.maskOpacity)},
    stroke: { alpha: 1, width: ${formatNumber(settings.maskStrokeWidth)} },
  }),
});`;
    case "labels":
      return `session.setPresentation({
  labelStyle: new BaseLabelStyle({
    background: {
      alpha: ${formatNumber(settings.labelBackgroundAlpha)},
      cornerRadius: ${formatNumber(settings.labelCornerRadius)},
    },
    includeConfidence: ${settings.labelIncludeConfidence},
    textStyle: { fontSize: ${formatNumber(settings.labelFontSize)} },
  }),
});`;
    case "polygons":
      return `session.setPresentation({
  polygonStyle: new BasePolygonStyle({
    fill: { alpha: ${formatNumber(settings.polygonFillAlpha)} },
    stroke: { width: ${formatNumber(settings.polygonStrokeWidth)} },
  }),
});`;
    case "polylines":
      return `session.setPresentation({
  polylineStyle: new BasePolylineStyle({
    stroke: { width: ${formatNumber(settings.polylineStrokeWidth)} },
  }),
});`;
    case "keypoints":
      return `session.setPresentation({
  keypointStyle: new BaseKeypointStyle({
    edgeStroke: { width: ${formatNumber(settings.keypointEdgeWidth)} },
    markerFill: { alpha: 1 },
    radius: ${formatNumber(settings.keypointRadius)},
  }),
});`;
  }
}

function formatNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}
