import { BaseBoxCornerStyle } from "#styles/box-corner-style";
import { BaseBoxStyle } from "#styles/box-style";
import { BaseKeypointStyle } from "#styles/keypoint-style";
import { BaseLabelStyle } from "#styles/label-style";
import { BaseMaskStyle } from "#styles/mask-style";
import { BaseMarkerStyle } from "#styles/marker-style";
import { BasePercentageBarStyle } from "#styles/percentage-bar-style";
import type { MaskHaloStyle } from "#types/mask-halo-style";
import { BasePolygonStyle } from "#styles/polygon-style";
import { BasePolylineStyle } from "#styles/polyline-style";
import { BoxShape } from "#types/box-style";
import type { EllipseStyle } from "#types/ellipse-style";
import type { Detection, SkeletonDefinitions } from "#types/detections";
import { LabelPlacement } from "#types/label-style";
import { MaskRenderMode } from "#types/mask-style";
import type { MediaRendererPresentation } from "#types/media-rendering";
import { resolveDetectionClassColorStyle } from "#utils/color-palette";

const DEFAULT_BOX_CORNER_RADIUS = 1;
const DEFAULT_ELLIPSE_AXIS_RATIO = 0.35;
const DEFAULT_ELLIPSE_START_ANGLE = (-45 * Math.PI) / 180;
const DEFAULT_ELLIPSE_END_ANGLE = (235 * Math.PI) / 180;
const DEFAULT_OUTLINE_WIDTH = 2;
const DEFAULT_FILL_ALPHA = 0.08;
const DEFAULT_MASK_FILL_ALPHA = 0.45;
const DEFAULT_KEYPOINT_EDGE_WIDTH = 1.5;
const DEFAULT_KEYPOINT_SHADOW_WIDTH = 3;
const DEFAULT_KEYPOINT_SHADOW_ALPHA = 0.25;
const DEFAULT_KEYPOINT_RADIUS = 3.5;
const DEFAULT_LABEL_CORNER_RADIUS = 4;
const DEFAULT_LABEL_PADDING_X = 6;
const DEFAULT_LABEL_PADDING_Y = 3;
const DEFAULT_LABEL_FONT_SIZE = 12;
const DEFAULT_LABEL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

export interface DefaultAnnotationPresentationOptions {
  /**
   * Resolve a project-specific color for a detection class. Return undefined
   * to fall back to supervision-js's stable class-color resolver.
   */
  readonly getClassColor?: (
    className: string | undefined,
  ) => number | undefined;
  /** Include confidence percentages in the default label text. */
  readonly includeConfidence?: boolean;
  /** Optional skeleton definitions used by the default keypoint style. */
  readonly skeletonDefinitions?: SkeletonDefinitions;
}

/**
 * Builds the canonical, unselected annotation presentation used by Roboflow's
 * Core annotation editor. It deliberately excludes host-specific interaction,
 * editing, focus, and theme behaviour so consumers can compose those layers.
 */
export function createDefaultAnnotationPresentation(
  options: DefaultAnnotationPresentationOptions = {},
): MediaRendererPresentation {
  return {
    boxStyle: createDefaultBoxStyle(options),
    keypointStyle: createDefaultKeypointStyle(options),
    labelStyle: createDefaultLabelStyle(options),
    maskStyle: createDefaultMaskStyle(options),
    polygonStyle: createDefaultPolygonStyle(options),
    polylineStyle: createDefaultPolylineStyle(options),
  };
}

/**
 * The canonical default style of one built-in layer.
 *
 * These exist so a renderer kind can build only the style it needs instead of
 * the whole default presentation. Keep them equivalent to the matching field of
 * {@link createDefaultAnnotationPresentation}.
 */
export function createDefaultBoxStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BaseBoxStyle {
  const getClassColor = createClassColorResolver(options);

  return new BaseBoxStyle({
    cornerRadius: DEFAULT_BOX_CORNER_RADIUS,
    fill: (detection) => ({
      alpha: DEFAULT_FILL_ALPHA,
      color: getClassColor(detection),
    }),
    shape: BoxShape.RoundedRect,
    shouldRender: (detection) =>
      !(
        detection.mask ||
        detection.polygon ||
        detection.polyline ||
        detection.keypoints
      ),
    stroke: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      width: DEFAULT_OUTLINE_WIDTH,
    }),
  });
}

/** Canonical opt-in BoxCornerAnnotator-style presentation. */
export function createDefaultBoxCornerStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BaseBoxCornerStyle {
  const getClassColor = createClassColorResolver(options);

  return new BaseBoxCornerStyle({
    stroke: (detection) => ({ color: getClassColor(detection) }),
  });
}

/**
 * Matches the Python Supervision EllipseAnnotator: an elliptical footprint
 * arc under the detection box, swept from -45deg to 235deg, in the class
 * color.
 */
export function createDefaultEllipseStyle(
  options: DefaultAnnotationPresentationOptions = {},
): EllipseStyle {
  const getClassColor = createClassColorResolver(options);

  return {
    resolve(detection, context) {
      if (!detection.rect || context.hidden) {
        return undefined;
      }

      const radiusX = detection.rect.width / 2;
      const radiusY = radiusX * DEFAULT_ELLIPSE_AXIS_RATIO;

      return {
        center: {
          x: detection.rect.x,
          // Bottom-tangent so the arc hugs the detection instead of dipping
          // below its feet.
          y: detection.rect.y + detection.rect.height / 2 - radiusY,
        },
        endAngle: DEFAULT_ELLIPSE_END_ANGLE,
        radiusX,
        radiusY,
        startAngle: DEFAULT_ELLIPSE_START_ANGLE,
        stroke: {
          alpha: 1,
          color: getClassColor(detection),
          width: DEFAULT_OUTLINE_WIDTH,
        },
      };
    },
  };
}

export function createDefaultKeypointStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BaseKeypointStyle {
  const getClassColor = createClassColorResolver(options);

  return new BaseKeypointStyle({
    ...(options.skeletonDefinitions === undefined
      ? {}
      : { definitions: options.skeletonDefinitions }),
    edgeShadowStroke: {
      alpha: DEFAULT_KEYPOINT_SHADOW_ALPHA,
      color: 0x000000,
      width: DEFAULT_KEYPOINT_SHADOW_WIDTH,
    },
    edgeStroke: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      width: DEFAULT_KEYPOINT_EDGE_WIDTH,
    }),
    markerFill: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
    }),
    markerStroke: { alpha: 1, color: 0xffffff, width: 1 },
    radius: DEFAULT_KEYPOINT_RADIUS,
  });
}

export function createDefaultLabelStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BaseLabelStyle {
  const getClassColor = createClassColorResolver(options);

  return new BaseLabelStyle({
    background: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      cornerRadius: DEFAULT_LABEL_CORNER_RADIUS,
      paddingX: DEFAULT_LABEL_PADDING_X,
      paddingY: DEFAULT_LABEL_PADDING_Y,
      topCornersOnly: true,
    }),
    includeConfidence: options.includeConfidence,
    placement: LabelPlacement.Top,
    textStyle: {
      fontFamily: DEFAULT_LABEL_FONT_FAMILY,
      fontSize: DEFAULT_LABEL_FONT_SIZE,
      fontWeight: "600",
    },
  });
}

export function createDefaultMaskStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BaseMaskStyle {
  const getClassColor = createClassColorResolver(options);

  return new BaseMaskStyle({
    color: (detection) => getClassColor(detection),
    fillAlpha: DEFAULT_MASK_FILL_ALPHA,
    mode: MaskRenderMode.FillAndStroke,
    opacity: 1,
    stroke: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      width: DEFAULT_OUTLINE_WIDTH,
    }),
  });
}

/** Canonical opt-in marker presentation. */
export function createDefaultMarkerStyle(): BaseMarkerStyle {
  return new BaseMarkerStyle();
}

const DEFAULT_MASK_HALO_ALPHA = 0.6;
const DEFAULT_MASK_HALO_SPREAD = 12;

/**
 * Canonical mask halo: a class-colored glow that follows the mask silhouette.
 * Used when the `maskHalo` renderer is listed without an explicit style.
 */
export function createDefaultMaskHaloStyle(
  options: DefaultAnnotationPresentationOptions = {},
): MaskHaloStyle {
  const getClassColor = createClassColorResolver(options);

  return {
    resolve(detection, context) {
      if (!detection.mask || context.hidden) {
        return undefined;
      }

      return {
        alpha: DEFAULT_MASK_HALO_ALPHA,
        color: getClassColor(detection),
        spread: DEFAULT_MASK_HALO_SPREAD,
      };
    },
  };
}

export function createDefaultPolygonStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BasePolygonStyle {
  const getClassColor = createClassColorResolver(options);

  return new BasePolygonStyle({
    fill: (detection) => ({
      alpha: DEFAULT_FILL_ALPHA,
      color: getClassColor(detection),
    }),
    stroke: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      width: DEFAULT_OUTLINE_WIDTH,
    }),
  });
}

export function createDefaultPolylineStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BasePolylineStyle {
  const getClassColor = createClassColorResolver(options);

  return new BasePolylineStyle({
    stroke: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
      width: DEFAULT_OUTLINE_WIDTH,
    }),
  });
}

export function createDefaultPercentageBarStyle(
  options: DefaultAnnotationPresentationOptions = {},
): BasePercentageBarStyle {
  const getClassColor = createClassColorResolver(options);

  return new BasePercentageBarStyle({
    fill: (detection) => ({
      alpha: 1,
      color: getClassColor(detection),
    }),
  });
}

function createClassColorResolver(
  options: DefaultAnnotationPresentationOptions,
) {
  return (detection: Detection) =>
    resolveDefaultClassColor(detection, options.getClassColor);
}

function resolveDefaultClassColor(
  detection: Detection,
  getClassColor: DefaultAnnotationPresentationOptions["getClassColor"],
) {
  const color = getClassColor?.(detection.className);

  return typeof color === "number" && Number.isFinite(color)
    ? color
    : resolveDetectionClassColorStyle(detection.className).fill;
}
