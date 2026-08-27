import { MarkerShape, type DetectionFrame } from "supervision";
import {
  demoMarkerPositionOffsets,
  type DemoMarkerPosition,
  type DemoPresentationSettings,
} from "./presentation/demo-presentation";

const DOCS_ELLIPSE_COLOR = 0x8b5cf6;
const DOCS_MASK_HALO_COLOR = 0x8b5cf6;

const BASKETBALL_TRACE_CLASS_NAME = "basketball";
const BASKETBALL_TRACE_TRACK_ID = "basketball-track:0";

export const docsAnnotationRendererIds = [
  "boxes",
  "box-corners",
  "ellipse",
  "masks",
  "mask-halo",
  "markers",
  "labels",
  "polygons",
  "polylines",
  "keypoints",
  "regions",
  "region-effects",
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

export type DocsAnnotationRendererSelectSetting =
  "markerPosition" | "markerShape";

export interface DocsAnnotationRendererSelectControl {
  readonly key: DocsAnnotationRendererSelectSetting;
  readonly label: string;
  readonly options: readonly {
    readonly label: string;
    readonly value: DemoPresentationSettings[DocsAnnotationRendererSelectSetting];
  }[];
}

export interface DocsAnnotationRendererDefinition {
  readonly controls: readonly DocsAnnotationRendererControl[];
  readonly description: string;
  readonly selects?: readonly DocsAnnotationRendererSelectControl[];
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
  "box-corners": {
    controls: [
      {
        key: "boxCornerLength",
        label: "Corner length",
        max: 48,
        min: 4,
        step: 1,
        unit: "pixels",
      },
      {
        key: "boxCornerStrokeWidth",
        label: "Stroke width",
        max: 8,
        min: 1,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Four open corner segments derived from detection bounds",
    title: "Box Corners",
  },
  ellipse: {
    controls: [
      {
        key: "ellipseStrokeWidth",
        label: "Stroke width",
        max: 8,
        min: 1,
        step: 1,
        unit: "pixels",
      },
      {
        key: "ellipseAxisRatio",
        label: "Axis ratio",
        max: 0.6,
        min: 0.15,
        step: 0.01,
        unit: "percent",
      },
    ],
    description: "Elliptical footprint arc under each detection",
    title: "Ellipse",
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
  "mask-halo": {
    controls: [
      {
        key: "maskHaloSpread",
        label: "Spread",
        max: 32,
        min: 4,
        step: 1,
        unit: "pixels",
      },
      {
        key: "maskHaloAlpha",
        label: "Glow opacity",
        max: 1,
        min: 0,
        step: 0.01,
        unit: "percent",
      },
    ],
    description: "GPU glow following the exact mask silhouette",
    title: "Mask Halo",
  },
  markers: {
    controls: [
      {
        key: "markerSize",
        label: "Marker size",
        max: 32,
        min: 4,
        step: 1,
        unit: "pixels",
      },
      {
        key: "markerStrokeWidth",
        label: "Stroke width",
        max: 8,
        min: 1,
        step: 1,
        unit: "pixels",
      },
    ],
    description: "Geometric markers anchored to detection bounds",
    selects: [
      {
        key: "markerShape",
        label: "Shape",
        options: [
          { label: "Circle", value: MarkerShape.Circle },
          { label: "Square", value: MarkerShape.Square },
          { label: "Triangle", value: MarkerShape.Triangle },
          { label: "Cross", value: MarkerShape.Cross },
        ],
      },
      {
        key: "markerPosition",
        label: "Position",
        options: [
          { label: "Top left", value: "top-left" },
          { label: "Top center", value: "top-center" },
          { label: "Top right", value: "top-right" },
          { label: "Center left", value: "center-left" },
          { label: "Center", value: "center" },
          { label: "Center right", value: "center-right" },
          { label: "Bottom left", value: "bottom-left" },
          { label: "Bottom center", value: "bottom-center" },
          { label: "Bottom right", value: "bottom-right" },
        ],
      },
    ],
    title: "Markers",
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
    description:
      "Media crops and asset overlays anchored to detection geometry",
    title: "Regions",
  },
  "region-effects": {
    controls: [],
    description: "Bounded media effects and focus composition",
    title: "Region Effects",
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
    boxCornersEnabled: renderer === "box-corners",
    // Pinned so the live snippet's fixed color is exactly what renders.
    ellipseColor: DOCS_ELLIPSE_COLOR,
    ellipsesEnabled: renderer === "ellipse",
    focusEnabled: false,
    keypointsEnabled: renderer === "keypoints",
    labelsEnabled: renderer === "labels",
    // The halo page renders the glow alone so the silhouette-following
    // effect is unmistakable; the scene prepares mask coverage internally.
    // Pinned so the live snippet's fixed color is exactly what renders.
    maskHaloColor: DOCS_MASK_HALO_COLOR,
    maskHaloEnabled: renderer === "mask-halo",
    masksEnabled: renderer === "masks" || renderer === "polylines",
    markersEnabled: renderer === "markers",
    ...(renderer === "markers"
      ? {
          markerPosition: "bottom-center" as const,
          markerShape: MarkerShape.Triangle,
        }
      : {}),
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
    case "ellipse":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.ellipse({
      style: {
        resolve: (detection) => {
          if (!detection.rect) return undefined;
          const radiusX = detection.rect.width / 2;
          const radiusY = radiusX * ${formatNumber(settings.ellipseAxisRatio)};
          return {
            center: {
              x: detection.rect.x,
              y: detection.rect.y + detection.rect.height / 2 - radiusY,
            },
            endAngle: (235 * Math.PI) / 180,
            radiusX,
            radiusY,
            startAngle: (-45 * Math.PI) / 180,
            stroke: {
              alpha: 1,
              color: ${formatColor(DOCS_ELLIPSE_COLOR)},
              width: ${formatNumber(settings.ellipseStrokeWidth)},
            },
          };
        },
      },
    }),
  ],
});`;
    case "box-corners":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.boxCorners({
      style: new BaseBoxCornerStyle({
        length: ${formatNumber(settings.boxCornerLength)},
        stroke: { width: ${formatNumber(settings.boxCornerStrokeWidth)} },
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
    case "mask-halo":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.maskHalo({
      style: {
        resolve: (detection) =>
          detection.mask
            ? {
                alpha: ${formatNumber(settings.maskHaloAlpha)},
                color: ${formatColor(DOCS_MASK_HALO_COLOR)},
                spread: ${formatNumber(settings.maskHaloSpread)},
              }
            : undefined,
      },
    }),
  ],
});`;
    case "markers":
      return `session.setPresentation({
  renderers: [
    annotationRenderers.marker({
      style: new BaseMarkerStyle({
        center: (detection) => {
          const rect = detection.rect;
          if (!rect) return undefined;
          return {
            x: ${formatMarkerCoordinate("x", settings.markerPosition)},
            y: ${formatMarkerCoordinate("y", settings.markerPosition)},
          };
        },
        shape: MarkerShape.${markerShapeMemberNames[settings.markerShape]},
        size: ${formatNumber(settings.markerSize)},
        stroke: { width: ${formatNumber(settings.markerStrokeWidth)} },
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

function formatColor(color: number) {
  return `0x${color.toString(16).padStart(6, "0")}`;
}

const markerShapeMemberNames: Readonly<Record<MarkerShape, string>> = {
  [MarkerShape.Circle]: "Circle",
  [MarkerShape.Cross]: "Cross",
  [MarkerShape.Square]: "Square",
  [MarkerShape.Triangle]: "Triangle",
};

function formatMarkerCoordinate(axis: "x" | "y", position: DemoMarkerPosition) {
  const offset = demoMarkerPositionOffsets[position][axis];
  const dimension = axis === "x" ? "width" : "height";

  if (offset === 0) return `rect.${axis}`;

  return `rect.${axis} ${offset < 0 ? "-" : "+"} rect.${dimension} / 2`;
}
