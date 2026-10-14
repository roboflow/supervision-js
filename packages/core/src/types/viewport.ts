import type { Point } from "#types/detections";

export interface ViewportTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly locked: boolean;
}

export interface ViewportController {
  getTransform(): ViewportTransform;
  screenToMedia(point: Point): Point;
  mediaToScreen(point: Point): Point;
  /** Explicit viewport updates remain available while gestures are locked.
   * Positive finite scales are applied exactly, so a view restored against a
   * new fit is not constrained by the ordinary gesture zoom range. */
  setTransform(transform: Partial<Omit<ViewportTransform, "locked">>): void;
  setLocked(locked: boolean): void;
  panBy(dx: number, dy: number): void;
  zoomAt(point: Point, factor: number): void;
  zoomFromWheel(point: Point, deltaY: number): void;
  subscribe(listener: (transform: ViewportTransform) => void): () => void;
}
