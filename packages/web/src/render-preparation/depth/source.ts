import {
  validateDepthMap,
  type DepthMap,
  type DepthPreviewLevels,
} from "supervision-js-core";
import type { DepthPreviewDecoding } from "#media/depth-preview-probe";
import type {
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "#media/depth-preview-track";
import type { MediaFrameClock } from "#types/media-frame-clock";
import type { MediaRendererDepthInput } from "#types/media-depth";
import type {
  RenderPreparationDepthOptions,
  RenderPreparationDiagnostics,
  RenderPreparationMaskFrameOptions,
  ResolvedRenderPreparationGateThresholds,
} from "#types/render-preparation";
import { openDepthClip } from "./clip";
import { assertMediaAspect, loadDepthManifest, loadDepthMap } from "./files";
import type { DepthFramePreparer } from "./frame-preparer";
import type { DepthPreviewLumaCopier } from "./preview-luma";

/** One depth map ready to draw, and which frame of depth it is. */
export interface DepthFrameEntry {
  readonly map: DepthMap;
  readonly frameIndex: number | null;
  readonly precision: "exact" | "preview";
}

/** What the depth layer reads to find the map for a media time. */
export interface DepthFrameProvider {
  /**
   * The depth to draw over the frame at `mediaTime`, or null to draw none.
   * The layer asks only for the frame it is drawing, so a clip takes each
   * call as naming the frame on screen.
   */
  getEntry(mediaTime: number): DepthFrameEntry | null;
  /**
   * Whether playback runs or a drag is still moving. A clip fetches exact
   * frames only once this has been false for a moment, and draws its preview
   * until then.
   */
  setPlaybackActive?(active: boolean): void;
  /** Whether a drag, not playback, holds the playhead. */
  setScrubbing?(scrubbing: boolean): void;
  /** Whether playback wraps at the media end: decoding ahead wraps with it. */
  setLoop?(loop: boolean): void;
  /** Calls `listener` whenever an answer of `getEntry` may have changed. */
  subscribe?(listener: () => void): () => void;
  /** The playhead moved: decoding ahead follows it. Never called in a present. */
  prefetch?(mediaTime: number): void;
  /**
   * The entries the next presents may draw, nearest first, so their
   * textures can go up before those presents: `count` frames in a row from
   * `skip` frames after the one at `mediaTime`. Above 1x a present skips
   * frames, and `skip` is how many it last moved.
   */
  getUpcomingEntries?(
    mediaTime: number,
    count: number,
    skip?: number,
  ): readonly DepthFrameEntry[];
  /** Whether the frame at `mediaTime` has to wait for depth before it shows. */
  needsPlaybackGateWait?(
    mediaTime: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
  ): boolean;
  /** Resolves once depth leads `mediaTime` as far as the thresholds ask. */
  waitForReady?(
    mediaTime: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Depth frames prepared ahead, counted up across the source's life. */
  getPreparationProgress?(): number;
  /**
   * The depth frame `getEntry` answers for `mediaTime`, without drawing it,
   * and whether it is decoded yet. Null where there is no depth frame.
   */
  getFrameStatus?(
    mediaTime: number,
  ): { readonly frameIndex: number | null; readonly prepared: boolean } | null;
  destroy(): void;
}

export interface DepthSourceContext {
  /** The media the map is stretched over. */
  readonly media: { readonly width: number; readonly height: number };
  /**
   * The media's frame index. A clip needs it to pair each depth frame with
   * the video frame it measures.
   */
  readonly frameClock?: MediaFrameClock | null;
  /**
   * Reads the frame index for media that does not keep one, the first time
   * a clip asks: a Mediabunny URL or Blob.
   */
  readonly readFrameClock?: (() => Promise<MediaFrameClock>) | null;
  /** Why the media has no frame index, told to a clip that needs one. */
  readonly frameClockUnavailableReason?: string;
  /** The decoder, created only when a manifest needs one. */
  readonly preparer?: () => DepthFramePreparer;
  readonly fetch?: typeof globalThis.fetch;
  /** Pad odd-width rows for WebGL while decoding, off the main thread. */
  readonly padRowsForWebGl?: boolean;
  /**
   * The box the picture is shown in. Exact depth at least twice the size the
   * box shows at its pixel ratio is uploaded shrunk by that whole factor,
   * prepared while decoding; readouts keep the full map.
   */
  readonly display?: RenderPreparationMaskFrameOptions["display"];
  readonly signal?: AbortSignal;
  readonly depth?: RenderPreparationDepthOptions;
  /**
   * The mask window's schedule batch, which also sizes what the preview keeps
   * at rest: masks and depth keep the same margin ahead of a paused frame.
   */
  readonly scheduleBatchSize?: number;
  /**
   * Opens a clip's preview video; null leaves the preview out. Defaults to
   * the WebCodecs decoder, loaded on first use.
   */
  readonly openPreviewTrack?:
    | ((
        url: string,
        options?: DepthPreviewTrackOptions,
      ) => Promise<DepthPreviewTrackReader>)
    | null;
  /**
   * Copies decoded preview frames' luma out, made when a preview first opens:
   * the session's render-preparation worker keeps those copies off the page.
   * Without one, they run on the page.
   */
  readonly previewLumaCopier?: () => DepthPreviewLumaCopier;
  /**
   * Picks, once per page and level, the decoder that returns preview codes
   * as written; null skips the probe and leaves the choice to the browser.
   */
  readonly choosePreviewDecoding?:
    ((levels: DepthPreviewLevels) => Promise<DepthPreviewDecoding>) | null;
  /** Hears the preview window's state: its lead, frames held and gate holds. */
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
}

/**
 * Checks a depth input against the media it will be drawn over and opens it.
 * A still map, given or loaded from an image manifest, answers every media
 * time with itself. A clip manifest answers with the exact frame for the
 * video frame on screen once playback rests.
 */
export async function openDepthSource(
  input: MediaRendererDepthInput,
  context: DepthSourceContext,
): Promise<DepthFrameProvider> {
  validateDepthInput(input);

  if (isMapInput(input)) {
    assertMediaAspect(input.map, context.media);
    return createStillDepthSource(input.map);
  }

  const { base, manifest } = await loadDepthManifest(input, context);

  assertMediaAspect(manifest, context.media);

  if (manifest.frames) {
    return await openDepthClip(manifest, manifest.frames, base, context);
  }
  if (!manifest.image) {
    throw new RangeError("depth.json needs an image or frames.");
  }

  return createStillDepthSource(
    await loadDepthMap(manifest, manifest.image, base, context, context.signal),
  );
}

/** Rejects an input whose shape no renderer could draw, before any media opens. */
export function validateDepthInput(input: MediaRendererDepthInput): void {
  if (typeof input !== "object" || input === null) {
    throw new RangeError("Depth input needs a map or a manifest.");
  }

  const hasMap = "map" in input && input.map !== undefined;
  const hasManifest = "manifest" in input && input.manifest !== undefined;

  if (hasMap === hasManifest) {
    throw new RangeError("Depth input needs either a map or a manifest.");
  }
  if (isMapInput(input)) {
    validateDepthMap(input.map);
    return;
  }

  const { manifest } = input;

  if (
    typeof manifest !== "string" &&
    !(manifest instanceof URL) &&
    (typeof manifest !== "object" || manifest === null)
  ) {
    throw new RangeError(
      "Depth manifest must be a URL or a parsed depth manifest.",
    );
  }
}

function isMapInput(
  input: MediaRendererDepthInput,
): input is Extract<MediaRendererDepthInput, { map: DepthMap }> {
  return "map" in input && input.map !== undefined;
}

function createStillDepthSource(map: DepthMap): DepthFrameProvider {
  const entry: DepthFrameEntry = { frameIndex: null, map, precision: "exact" };

  return {
    destroy: () => undefined,
    getEntry: () => entry,
  };
}
