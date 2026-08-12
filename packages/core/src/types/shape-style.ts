import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { Detection, Point } from "#types/detections";
import type { AnnotationStyleContext } from "#types/style";

/**
 * Discriminator for renderer-neutral shape draw instructions.
 */
export enum ShapeInstructionKind {
  Ellipse = "ellipse",
  Icon = "icon",
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
export interface EllipseShapeInstruction {
  readonly kind: ShapeInstructionKind.Ellipse;
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  /** Rotation in radians around the center. */
  readonly rotation?: number;
  readonly startAngle?: number;
  readonly endAngle?: number;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

/**
 * Anchored marker at a media-space point.
 *
 * At rotation `0` a triangle points toward positive y (down in media space),
 * matching the annotator convention of marking the object beneath the tip.
 */
export interface MarkerShapeInstruction {
  readonly kind: ShapeInstructionKind.Marker;
  readonly point: Point;
  readonly shape: MarkerShape;
  /** Marker diameter in the declared size space. */
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
  /** Rotation in radians around the anchor point. */
  readonly rotation?: number;
  readonly fill?: BoxFillStyle;
  readonly stroke?: BoxStrokeStyle;
}

/**
 * One or more disconnected subpaths sharing a single style.
 */
export interface PathShapeInstruction {
  readonly kind: ShapeInstructionKind.Path;
  readonly segments: readonly (readonly Point[])[];
  readonly closed: boolean;
  readonly fill?: BoxFillStyle;
  readonly stroke: BoxStrokeStyle;
}

/**
 * Image icon anchored at a media-space point.
 *
 * `href` is a renderer-neutral image reference (URL or data URL). Backends
 * load and cache the image asynchronously; an icon whose image has not
 * finished loading is skipped for that frame and drawn once available.
 */
export interface IconShapeInstruction {
  readonly kind: ShapeInstructionKind.Icon;
  readonly point: Point;
  readonly href: string;
  /** Icon width and height in the declared size space. */
  readonly size: number;
  readonly sizeSpace: MarkerSizeSpace;
}

export type ShapeDrawInstruction =
  | EllipseShapeInstruction
  | IconShapeInstruction
  | MarkerShapeInstruction
  | PathShapeInstruction;

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
