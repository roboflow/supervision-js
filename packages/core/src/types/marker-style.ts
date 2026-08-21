import type { Detection, Point } from "#types/detections";
import type {
  FillStyle,
  OpenStrokeStyle,
  StrokeStyle,
} from "#types/paint-style";
import { MarkerShape, MarkerSizeSpace } from "#types/shape-style";
import type {
  AnnotationStyleContext,
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export type MarkerStyleContext = AnnotationStyleContext;

interface MarkerDrawInstructionBase {
  readonly center: Point;
  readonly shape: MarkerShape;
  /** Marker diameter in the declared size space. */
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
  readonly rotation?: number;
}

export interface ClosedMarkerDrawInstruction extends MarkerDrawInstructionBase {
  readonly shape:
    MarkerShape.Circle | MarkerShape.Square | MarkerShape.Triangle;
  readonly fill?: FillStyle;
  readonly stroke?: StrokeStyle;
}

export interface CrossMarkerDrawInstruction extends MarkerDrawInstructionBase {
  readonly shape: MarkerShape.Cross;
  readonly fill?: never;
  readonly stroke?: OpenStrokeStyle;
}

export type MarkerDrawInstruction =
  ClosedMarkerDrawInstruction | CrossMarkerDrawInstruction;

/**
 * Style contract of the `marker` annotation renderer.
 *
 * A style maps a semantic detection to one positioned marker. The renderer is
 * presentation-only and does not change picking or editing geometry.
 */
export interface MarkerStyle {
  resolve(
    detection: Detection,
    context: MarkerStyleContext,
  ): MarkerDrawInstruction | undefined;
}

export interface BaseMarkerStyleOptions {
  /** Optional media-space anchor. The default is the detection-rect center. */
  readonly center?: DetectionStyleValue<Point | undefined, MarkerStyleContext>;
  readonly shape?: DetectionStyleValue<MarkerShape, MarkerStyleContext>;
  readonly size?: DetectionStyleValue<number, MarkerStyleContext>;
  readonly sizeSpace?: DetectionStyleValue<MarkerSizeSpace, MarkerStyleContext>;
  readonly rotation?: DetectionStyleValue<
    number | undefined,
    MarkerStyleContext
  >;
  readonly fill?: DetectionStyleValue<
    Partial<FillStyle> | null,
    MarkerStyleContext
  >;
  readonly stroke?: DetectionStyleValue<
    Partial<StrokeStyle> | null,
    MarkerStyleContext
  >;
  readonly shouldRender?: DetectionStylePredicate<MarkerStyleContext>;
}
