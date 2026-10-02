import type {
  DepthPlaybackSource,
  RenderPreparationDepthOptions,
} from "#types/render-preparation";
import { getPausedPreparedWindowFrameCount } from "../playhead-motion";
import { DEFAULT_MASK_SCHEDULE_BATCH_SIZE } from "../prepared-render-window";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_PREFETCH_SECONDS = 1;
/** Kept behind the playhead, in seconds of media. */
const RETAIN_SECONDS = 0.25;
/** Rest before the exact frame on screen loads. */
const EXACT_SETTLE_SECONDS = 0.15;
/** Exact frames loaded on each side of the frame at rest, for stepping. */
const EXACT_NEIGHBOR_FRAME_COUNT = 2;
const MIN_EXACT_CACHE_BYTES = 128 * MEBIBYTE;
/** The window budgets' floor: what a 1080p preview needs for a 1.35 s lead. */
const MIN_WINDOW_CACHE_BYTES = 96 * MEBIBYTE;
/** And their ceiling: 64 frames of 4K preview, about two seconds at 30 fps. */
const MAX_WINDOW_CACHE_BYTES = 512 * MEBIBYTE;

export interface DepthClipOptions {
  /** Exact frames loaded around the frame at rest. */
  readonly exact: {
    readonly settleSeconds: number;
    readonly neighborFrameCount: number;
    /** The frame on screen is always kept, whatever this says. */
    readonly maxCacheBytes: number;
  };
  readonly playback: {
    readonly source: DepthPlaybackSource;
    readonly maxExactCacheBytes: number;
  };
  /** What the preview window, and the exact playback window, decode ahead. */
  readonly preview: {
    readonly maxCacheBytes: number;
    /** Frames a resting playhead keeps decoded ahead, its own included. */
    readonly pausedFrameCount: number;
    readonly prefetchSeconds: number;
    readonly retainSeconds: number;
  };
}

/**
 * The clip's budgets and timing. Byte budgets that are not given scale with
 * the clip's resolution, so a 4K clip keeps about as many seconds as a 720p
 * one.
 */
export function resolveDepthClipOptions(
  clip: {
    /** Its confidence plane included. */
    readonly exactFrameBytes: number;
    /** 0 without a preview. */
    readonly previewFrameBytes: number;
    readonly frameRate: number;
  },
  options: RenderPreparationDepthOptions = {},
  shared: { readonly scheduleBatchSize?: number } = {},
): DepthClipOptions {
  const prefetchSeconds = Math.max(
    0,
    options.previewPrefetchSeconds ?? DEFAULT_PREFETCH_SECONDS,
  );
  const frameRate =
    Number.isFinite(clip.frameRate) && clip.frameRate > 0 ? clip.frameRate : 30;
  const windowSpanFrames = Math.ceil(
    (2 * prefetchSeconds + RETAIN_SECONDS) * frameRate,
  );
  const windowBudget = (frameBytes: number) =>
    Math.min(
      MAX_WINDOW_CACHE_BYTES,
      Math.max(MIN_WINDOW_CACHE_BYTES, frameBytes * windowSpanFrames),
    );

  return {
    exact: {
      maxCacheBytes: Math.max(
        MIN_EXACT_CACHE_BYTES,
        clip.exactFrameBytes * (2 * EXACT_NEIGHBOR_FRAME_COUNT + 1) * 2,
      ),
      neighborFrameCount: EXACT_NEIGHBOR_FRAME_COUNT,
      settleSeconds: EXACT_SETTLE_SECONDS,
    },
    playback: {
      maxExactCacheBytes:
        options.maxExactPlaybackCacheBytes ??
        windowBudget(clip.exactFrameBytes),
      source:
        options.playback === "exact" || options.playback === "preview"
          ? options.playback
          : "auto",
    },
    preview: {
      maxCacheBytes:
        options.maxPreviewCacheBytes ?? windowBudget(clip.previewFrameBytes),
      // The mask window's paused margin, and never fewer than the neighbours
      // a step reaches.
      pausedFrameCount: Math.max(
        EXACT_NEIGHBOR_FRAME_COUNT + 1,
        getPausedPreparedWindowFrameCount({
          prefetchFrameCount: Math.ceil(prefetchSeconds * frameRate),
          scheduleBatchSize: Math.max(
            1,
            shared.scheduleBatchSize ?? DEFAULT_MASK_SCHEDULE_BATCH_SIZE,
          ),
        }),
      ),
      prefetchSeconds,
      retainSeconds: RETAIN_SECONDS,
    },
  };
}
