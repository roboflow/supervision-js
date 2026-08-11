/** Alignment for strokes applied to closed rendered geometry. */
export enum StrokeAlignment {
  Inside = "inside",
  Center = "center",
  Outside = "outside",
}

/** Shape used at the exposed endpoints of an open stroke. */
export type StrokeCap = "butt" | "round" | "square";

/** Shape used where consecutive stroke segments meet. */
export type StrokeJoin = "bevel" | "miter" | "round";

/** Renderer-neutral stroke paint shared by boxes, paths, and shape primitives. */
export interface StrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
  readonly alignment?: StrokeAlignment;
  readonly cap?: StrokeCap;
  readonly join?: StrokeJoin;
  /** Maximum miter length as a multiple of the stroke width. */
  readonly miterLimit?: number;
  /** Alternating dash and gap lengths in screen pixels. */
  readonly dash?: readonly number[];
}

/**
 * Stroke paint for open geometry. Alignment is intentionally unavailable:
 * inside and outside have no stable meaning without a closed region.
 */
export type OpenStrokeStyle = Omit<StrokeStyle, "alignment"> & {
  readonly alignment?: never;
};

/** Renderer-neutral fill paint shared by closed geometry. */
export interface FillStyle {
  readonly color: number;
  readonly alpha: number;
}
