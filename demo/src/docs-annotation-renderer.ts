import type { DetectionFrame } from "supervision";
import type { DemoPresentationSettings } from "./presentation/demo-presentation";

const BASKETBALL_TRACE_CLASS_NAME = "basketball";
const BASKETBALL_TRACE_TRACK_ID = "basketball-track:0";

export const docsAnnotationRendererIds = [
  "boxes",
  "masks",
  "labels",
  "polygons",
  "polylines",
  "keypoints",
  "regions",
] as const;

export type DocsAnnotationRendererId =
  (typeof docsAnnotationRendererIds)[number];

export interface DocsAnnotationRendererControl {
  readonly key: NumericPresentationSetting;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly step: number;
  readonly unit: "percent" | "pixels";
}

export interface DocsAnnotationRendererDefinition {
  readonly controls: readonly DocsAnnotationRendererControl[];
  readonly description: string;
  readonly title: string;
}

export type NumericPresentationSetting = {
  [
    Key in keyof DemoPresentationSettings
  ]: DemoPresentationSettings[Key] extends number ? Key : never;
}[keyof DemoPresentationSettings];

export const docsAnnotationRenderers: Readonly<
  Record<DocsAnnotationRendererId, DocsAnnotationRendererDefinition>
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
  regions: {
    controls: [],
    description: "Asset overlays anchored to detection geometry",
    title: "Asset Regions",
  },
};

export function parseDocsAnnotationRenderer(
  value: string | null,
): DocsAnnotationRendererId {
  return docsAnnotationRendererIds.includes(value as DocsAnnotationRendererId)
    ? (value as DocsAnnotationRendererId)
    : "boxes";
}

export function createDocsAnnotationRendererPresentation(
  renderer: DocsAnnotationRendererId,
): Partial<DemoPresentationSettings> {
  return {
    boxesEnabled: renderer === "boxes",
    focusEnabled: false,
    keypointsEnabled: renderer === "keypoints",
    labelsEnabled: renderer === "labels",
    masksEnabled: renderer === "masks" || renderer === "polylines",
    polygonsEnabled: renderer === "polygons",
    polylinesEnabled: renderer === "polylines",
    maskFillAlpha: 1,
    maskOpacity: 0.72,
  };
}

/**
 * The polyline page scopes the committed basketball fixture to its one
 * explicitly derived trace. This only selects frozen semantic detections; it
 * never adds or synthesizes geometry in the docs runtime.
 */
export function filterDocsAnnotationRendererFrames(
  renderer: DocsAnnotationRendererId,
  frames: readonly DetectionFrame[],
): readonly DetectionFrame[] {
  if (renderer !== "polylines") return frames;

  return frames.map((frame) => ({
    ...frame,
    detections: frame.detections.filter(
      (detection) =>
        detection.className === BASKETBALL_TRACE_CLASS_NAME &&
        detection.metadata?.trajectoryTrackId === BASKETBALL_TRACE_TRACK_ID,
    ),
  }));
}

export function createDocsAnnotationRendererSnippet(
  renderer: DocsAnnotationRendererId,
  settings: DemoPresentationSettings,
) {
  switch (renderer) {
    case "boxes":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.box({
      style: new BaseBoxStyle({
        cornerRadius: ${formatNumber(settings.boxCornerRadius)},
        fill: { alpha: ${formatNumber(settings.boxFillAlpha)} },
        stroke: { width: ${formatNumber(settings.boxStrokeWidth)} },
      }),
    }),
  ],
});`;
    case "masks":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.mask({
      style: new BaseMaskStyle({
        fillAlpha: ${formatNumber(settings.maskFillAlpha)},
        opacity: ${formatNumber(settings.maskOpacity)},
        stroke: { alpha: 1, width: ${formatNumber(settings.maskStrokeWidth)} },
      }),
    }),
  ],
});`;
    case "labels":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.label({
      style: new BaseLabelStyle({
        background: {
          alpha: ${formatNumber(settings.labelBackgroundAlpha)},
          cornerRadius: ${formatNumber(settings.labelCornerRadius)},
        },
        includeConfidence: ${settings.labelIncludeConfidence},
        textStyle: { fontSize: ${formatNumber(settings.labelFontSize)} },
      }),
    }),
  ],
});`;
    case "polygons":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.polygon({
      style: new BasePolygonStyle({
        fill: { alpha: ${formatNumber(settings.polygonFillAlpha)} },
        stroke: { width: ${formatNumber(settings.polygonStrokeWidth)} },
      }),
    }),
  ],
});`;
    case "polylines":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.polyline({
      style: new BasePolylineStyle({
        stroke: { width: ${formatNumber(settings.polylineStrokeWidth)} },
      }),
    }),
  ],
});`;
    case "keypoints":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.keypoints({
      style: new BaseKeypointStyle({
        edgeStroke: { width: ${formatNumber(settings.keypointEdgeWidth)} },
        markerFill: { alpha: 1 },
        radius: ${formatNumber(settings.keypointRadius)},
      }),
    }),
  ],
});`;
    case "regions":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "player-fire",
      target: { className: ["white team player", "yellow team player"] },
      source: { kind: "asset", asset: { src: fireGifUrl } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      compose: { mode: "over" },
    }),
  ],
});`;
  }
}

function formatNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}
