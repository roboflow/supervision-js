import type { Detection, Point } from "#types/detections";
import type {
  FillStyle,
  OpenStrokeStyle,
  StrokeStyle,
} from "#types/paint-style";
import type { AnnotationStyleContext } from "#types/style";

/**
 * Discriminator for renderer-neutral shape draw instructions.
 */
export enum ShapeInstructionKind {
  Ellipse = "ellipse",
  Marker = "marker",
  Path = "path",
}

export enum MarkerShape {
  Circle = "circle",
  Cross = "cross",
  Square = "square",
  Triangle = "triangle",
}

/**
 * Coordinate space for marker sizing. Media sizes scale with the viewport;
 * screen sizes stay constant on screen, matching stroke-width semantics.
 */
export enum MarkerSizeSpace {
  Media = "media",
  Screen = "screen",
}

/**
 * Ellipse or elliptical arc in media coordinates.
 *
 * Omitting both angles draws a closed ellipse. Angles are radians measured
 * from the positive x axis before `rotation` is applied.
 */
interface EllipseShapeInstructionBase {
  readonly kind: ShapeInstructionKind.Ellipse;
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
}

export interface ClosedEllipseShapeInstruction extends EllipseShapeInstructionBase {
  readonly startAngle?: never;
  readonly endAngle?: never;
  readonly fill?: FillStyle;
  readonly stroke?: StrokeStyle;
}

export interface EllipseArcShapeInstruction extends EllipseShapeInstructionBase {
  readonly startAngle: number;
  readonly endAngle: number;
  readonly fill?: never;
  readonly stroke?: OpenStrokeStyle;
}

export type EllipseShapeInstruction =
  ClosedEllipseShapeInstruction | EllipseArcShapeInstruction;

/**
 * Anchored marker at a media-space point.
 *
 * At rotation `0` a triangle points toward positive y (down in media space).
 * `center` is always the geometric center; semantic anchoring belongs to the
 * renderer that creates this lower-level instruction.
 */
interface MarkerShapeInstructionBase {
  readonly kind: ShapeInstructionKind.Marker;
  readonly center: Point;
  /** Marker diameter in the declared size space. */
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
}

export interface ClosedMarkerShapeInstruction extends MarkerShapeInstructionBase {
  readonly shape:
    MarkerShape.Circle | MarkerShape.Square | MarkerShape.Triangle;
  readonly fill?: FillStyle;
  readonly stroke?: StrokeStyle;
}

export interface CrossMarkerShapeInstruction extends MarkerShapeInstructionBase {
  readonly shape: MarkerShape.Cross;
  readonly fill?: never;
  readonly stroke?: OpenStrokeStyle;
}

export type MarkerShapeInstruction =
  ClosedMarkerShapeInstruction | CrossMarkerShapeInstruction;

/**
 * One or more disconnected subpaths sharing a single style.
 */
interface PathShapeInstructionBase {
  readonly kind: ShapeInstructionKind.Path;
  readonly segments: readonly (readonly Point[])[];
}

export interface ClosedPathShapeInstruction extends PathShapeInstructionBase {
  readonly closed: true;
  readonly fill?: FillStyle;
  readonly stroke: StrokeStyle;
}

export interface OpenPathShapeInstruction extends PathShapeInstructionBase {
  readonly closed: false;
  readonly fill?: never;
  readonly stroke: OpenStrokeStyle;
}

export type PathShapeInstruction =
  ClosedPathShapeInstruction | OpenPathShapeInstruction;

export type ShapeDrawInstruction =
  EllipseShapeInstruction | MarkerShapeInstruction | PathShapeInstruction;

export type ShapeStyleContext = AnnotationStyleContext;

/**
 * Shape decoration contract.
 *
 * A style receives semantic detections and returns renderer-neutral shape
 * instructions derived from them. Shape decorations are presentation only:
 * they are not pickable and never become editable annotations. Return
 * `undefined` or an empty array to skip a detection.
 */
export interface ShapeStyle {
  resolve(
    detection: Detection,
    context: ShapeStyleContext,
  ): readonly ShapeDrawInstruction[] | undefined;
}
