import { resolveCacheBudgets } from "./cache-budget";
import { CanvasSinkScrubCursor } from "./canvas-sink-scrub-cursor";
import { FRAME_CACHE } from "./constants";
import { DecodeScheduler } from "./decode-scheduler";
import {
  type AnySourceHandle,
  isReopenableSource,
  openScrubSource,
} from "./decode-source";
import type { DecodeResolutionStrategy } from "./decode-resolution";
import { FrameCache } from "./frame-cache";
import type { ScrubCursor, ScrubCursorFactory } from "./scrub-cursor";
import type { SourceResidency } from "./source-residency";
import type {
  UrlSourceReadConfig,
  WebVideoEngineError,
  VideoSource,
} from "./types";

/** On-screen canvas measurements the decode strategy reasons over. */
export interface ScrubViewport {
  /** CSS-pixel width of the canvas box, or null when unmeasured. */
  displayWidth: number | null;
  devicePixelRatio: number;
}

/**
 * Cache tuning passed through to the scheduler. Frame dimensions are filled from
 * the resolved track. The budgets are optional overrides: omitted, they are
 * resolved per source from device memory and frame size by resolveCacheBudgets.
 */
export interface ScrubCacheConfig {
  previewWidth: number;
  previewCapacity?: number;
  exactBudgetBytes?: number;
}

export interface CreateScrubCursorOptions {
  source: VideoSource;
  /**
   * Decides the resolution frames are held and painted at: the display canvas
   * backing store and every cache blit. Combined with the viewport and the
   * track's native dimensions; defaults to native resolution when omitted.
   * On the CanvasSink path it also sizes the sink's own output, but a path
   * that owns its decoder decodes native and scales into these dimensions.
   */
  decodeStrategy?: DecodeResolutionStrategy;
  /** On-screen box the decodeStrategy may scale to. Native when omitted. */
  viewport?: ScrubViewport;
  /** CanvasSink frame-pool size. */
  poolSize?: number;
  /** Cache tuning. Omit or pass null for the uncached cursor. */
  cache?: ScrubCacheConfig | null;
  /** Pin the 2D renderer. Mirrors the controller flag; rules out the zero-copy
   *  sample path so a 2D consumer keeps the byte-identical CanvasSink path. */
  prefer2d?: boolean;
  /**
   * Called once when the decoder is judged unable to decode this source at
   * all. A failure after open() cannot surface as a rejected promise, since by
   * then nobody is awaiting one; this is how it reaches the transport.
   */
  onDecodeFailure?: (error: WebVideoEngineError) => void;
  /** Serves the demuxer's byte reads from what this process already holds. */
  sourceResidency?: SourceResidency;
  /** Read tuning for a URL source, passed through to mediabunny. */
  urlSource?: UrlSourceReadConfig;
  signal?: AbortSignal;
}

/**
 * Opens the decode source and chooses the cursor backend: the caching
 * DecodeScheduler when a cache config is given, otherwise the uncached
 * CanvasSinkScrubCursor. The returned cursor is already seeded with its first
 * frame, so callers receive a ready cursor with track metadata resolved.
 *
 * This is the single place the backend is chosen, so the gate is one branch and
 * both backends share the same opened source.
 */
export const createScrubCursor: ScrubCursorFactory = async (
  options: CreateScrubCursorOptions,
): Promise<ScrubCursor> => {
  const openSource = (): Promise<AnySourceHandle> => openScrubSource(options);
  const source = await openSource();
  // A URL/Blob re-opens cleanly for hang recovery; a one-shot stream cannot, so
  // the scheduler degrades rather than rebuilds when its source is a stream.
  const reopen = isReopenableSource(options.source) ? openSource : null;
  const cursor = buildCursor(source, options, reopen);
  try {
    await cursor.open();
  } catch (failure) {
    // An open that never produced a first frame still built a decoder and an
    // input over the source, and the caller has no cursor to close them with.
    await cursor.close().catch(() => undefined);
    throw failure;
  }
  return cursor;
};

function buildCursor(
  source: AnySourceHandle,
  options: CreateScrubCursorOptions,
  reopen: (() => Promise<AnySourceHandle>) | null,
): ScrubCursor {
  const cache = options.cache ?? null;
  if (cache) {
    return new DecodeScheduler({
      source,
      cache: buildCache(source.track, cache),
      reopen,
      onDecodeFailure: options.onDecodeFailure,
    });
  }
  return new CanvasSinkScrubCursor(source);
}

function buildCache(
  track: {
    decodeWidth: number;
    decodeHeight: number;
    nativeFps: number | null;
  },
  config: ScrubCacheConfig,
): FrameCache {
  const fps = track.nativeFps;
  const bucketMs =
    fps && fps > 0
      ? Math.max(1, Math.round(1000 / fps))
      : FRAME_CACHE.DEFAULT_BUCKET_MS;
  const budgets = resolveCacheBudgets(
    track.decodeWidth,
    track.decodeHeight,
    config.previewWidth,
  );
  return new FrameCache({
    exactWidth: track.decodeWidth,
    exactHeight: track.decodeHeight,
    previewWidth: config.previewWidth,
    exactBudgetBytes: config.exactBudgetBytes ?? budgets.exactBudgetBytes,
    previewCapacity: config.previewCapacity ?? budgets.previewCapacity,
    bucketMs,
    // Floor the exact tier to one full prefetch window so a huge-frame source
    // does not evict the very neighbors a settle just decoded.
    minExactSlots: FRAME_CACHE.MIN_EXACT_SLOTS,
  });
}
