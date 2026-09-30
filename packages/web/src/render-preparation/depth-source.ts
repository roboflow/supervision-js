import { validateDepthMap, type DepthMap } from "supervision-js-core";
import type { MediaRendererDepthInput } from "#types/media-depth";

/** How far a map's aspect ratio may stray from the media's. */
const DEPTH_ASPECT_TOLERANCE = 0.01;

/** One depth map ready to draw, and which frame of depth it is. */
export interface DepthFrameEntry {
  readonly map: DepthMap;
  readonly frameIndex: number | null;
  readonly precision: "exact" | "preview";
}

/**
 * What the depth layer reads to find the map for a media time. It stays
 * internal until a second producer needs to supply depth itself.
 */
export interface DepthFrameProvider {
  getEntry(mediaTime: number): DepthFrameEntry | null;
  destroy(): void;
}

/**
 * Checks a depth input against the media it will be drawn over and opens it.
 * A still map answers every media time with itself.
 */
export function openDepthSource(
  input: MediaRendererDepthInput,
  media: { readonly width: number; readonly height: number },
): DepthFrameProvider {
  validateDepthInput(input);

  const { map } = input;

  assertMediaAspect(map, media);

  const entry: DepthFrameEntry = { frameIndex: null, map, precision: "exact" };

  return {
    destroy: () => undefined,
    getEntry: () => entry,
  };
}

/** Rejects an input whose shape no renderer could draw, before any media opens. */
export function validateDepthInput(input: MediaRendererDepthInput): void {
  if (typeof input !== "object" || input === null || !input.map) {
    throw new RangeError("Depth input needs a map.");
  }

  validateDepthMap(input.map);
}

/**
 * The map is stretched over the media rectangle, so a map of another shape
 * would put depth beside the pixels it measures.
 */
function assertMediaAspect(
  map: DepthMap,
  media: { readonly width: number; readonly height: number },
): void {
  if (media.width <= 0 || media.height <= 0) {
    return;
  }

  const mediaAspect = media.width / media.height;
  const mapAspect = map.width / map.height;

  if (
    Math.abs(mapAspect - mediaAspect) >
    mediaAspect * DEPTH_ASPECT_TOLERANCE
  ) {
    throw new RangeError(
      `Depth map ${map.width}x${map.height} does not have the aspect ratio of the ${media.width}x${media.height} media.`,
    );
  }
}
