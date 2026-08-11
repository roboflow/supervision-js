/** Alignment for strokes applied to closed rendered geometry. */
export enum StrokeAlignment {
  Inside = "inside",
  Center = "center",
  Outside = "outside",
}

/** Renderer-neutral stroke paint shared by boxes, paths, and shape primitives. */
export interface StrokeStyle {
  readonly color: number;
  readonly alpha: number;
  readonly width: number;
  readonly alignment?: StrokeAlignment;
  /** Alternating dash and gap lengths in screen pixels. */
  readonly dash?: readonly number[];
}

/** Renderer-neutral fill paint shared by closed geometry. */
export interface FillStyle {
  readonly color: number;
  readonly alpha: number;
}
