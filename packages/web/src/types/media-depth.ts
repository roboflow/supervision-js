import type { DepthMap } from "supervision-js-core";

/**
 * Depth for the media a renderer presents.
 *
 * A `map` is one still depth map drawn under every frame, stretched over the
 * media rectangle; it must have the media's aspect ratio within 1 %. The
 * session keeps the map's arrays for readouts and never copies them.
 */
export interface MediaRendererDepthInput {
  readonly map: DepthMap;
}

/** The depth map on screen, for readouts such as `readDepthAt`. */
export interface ActiveDepthMap {
  readonly map: DepthMap;
  /** Clip frame index of the map, or null for a still map. */
  readonly frameIndex: number | null;
  /** Media time the map was drawn for, in seconds. */
  readonly mediaTime: number;
  /** `"preview"` while an approximate 8-bit map stands in for the exact one. */
  readonly precision: "exact" | "preview";
  /** Media size the map is stretched over, the coordinate space for readouts. */
  readonly mediaWidth: number;
  readonly mediaHeight: number;
}
