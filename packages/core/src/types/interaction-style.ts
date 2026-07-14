import type { BoxStyle } from "#types/box-style";
import type { Detection } from "#types/detections";
import type {
  DetectionPickPoint,
  DetectionPickTarget,
} from "#types/interaction";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { AnnotationStyleContext } from "#types/style";

export enum DetectionInteractionState {
  Hovered = "hovered",
  Selected = "selected",
}

/**
 * Per-frame context passed to an interaction style while resolving hover and
 * selected highlight instructions.
 */
export interface InteractionStyleContext extends AnnotationStyleContext {
  readonly state: DetectionInteractionState;
  readonly target: DetectionPickTarget;
  readonly point: DetectionPickPoint;
}

/**
 * State-specific presentation applied only to the active interaction target.
 *
 * These are the same renderer-neutral style contracts used by the base
 * presentation. Interaction state should not invent a separate primitive or
 * force mask interactions through rectangular box highlights.
 */
export interface InteractionPresentation {
  readonly boxStyle?: BoxStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskStyle?: MaskStyle | null;
  readonly polygonStyle?: PolygonStyle | null;
  readonly polylineStyle?: PolylineStyle | null;
  readonly keypointStyle?: KeypointStyle | null;
}

/**
 * Presentation contract for hover and selected detection highlights.
 */
export interface InteractionStyle {
  resolve(
    detection: Detection,
    context: InteractionStyleContext,
  ): InteractionPresentation | undefined;
}
