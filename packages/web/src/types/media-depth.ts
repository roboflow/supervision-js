import type { DepthManifest, DepthMap } from "supervision-js-core";

/**
 * Depth for the media a renderer presents: a map you already hold, or a
 * `depth.json` manifest the session loads.
 *
 * A `map` is one still depth map drawn under every frame, stretched over the
 * media rectangle; it must have the media's aspect ratio within 1 %. The
 * session keeps the map's arrays for readouts and never copies them.
 *
 * A `manifest` is the URL of a `depth.json`, or its `parseDepthManifest`
 * output. The session fetches the 16-bit PNG it names (and the confidence PNG,
 * when there is one), decodes it in the render-preparation worker, and draws
 * the map. Only still-image manifests (`image`) are drawn so far; a clip
 * manifest (`frames`) is refused with a `RangeError`.
 */
export type MediaRendererDepthInput =
  | {
      readonly map: DepthMap;
      readonly manifest?: undefined;
      readonly baseUrl?: undefined;
    }
  | {
      readonly manifest: string | URL | DepthManifest;
      /**
       * What a relative manifest URL, or the files of a manifest passed as an
       * object, resolve against. Files of a fetched manifest resolve against
       * the manifest's own URL.
       */
      readonly baseUrl?: string | URL;
      readonly map?: undefined;
    };

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
