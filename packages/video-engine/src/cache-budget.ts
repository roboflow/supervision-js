import { FRAME_CACHE } from "./constants";

/** navigator.deviceMemory is GB (Chromium-only, capped at 8 for privacy); absent
 *  on Safari/Firefox and in tests, where we assume a midrange machine. */
function deviceMemoryGb(): number {
  if (typeof navigator === "undefined")
    return FRAME_CACHE.DEFAULT_DEVICE_MEMORY_GB;
  const reported = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  return typeof reported === "number" && reported > 0
    ? reported
    : FRAME_CACHE.DEFAULT_DEVICE_MEMORY_GB;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export interface CacheBudgets {
  readonly exactBudgetBytes: number;
  readonly previewCapacity: number;
}

/**
 * Sizes both cache tiers to the device's reported RAM and the frame size.
 *
 * The exact tier holds a working set the access pattern fixes in frames, the
 * scrub prefetch window, so its slot floor survives any frame size and the RAM
 * band adds speculative slots on top only while a slot stays cheap. An 8MP
 * source lands on the floor and keeps nothing speculative, which is what holds
 * its resident footprint down; coverage past the window comes from the preview
 * tier at a 79th of the cost per slot. That tier has no working set to protect,
 * so its count is purely its byte budget over the downscaled frame size, which
 * gives a square 8MP source enough coarse history without over-allocating for a
 * small 16:9 one.
 */
export function resolveCacheBudgets(
  decodeWidth: number,
  decodeHeight: number,
  previewWidth: number,
): CacheBudgets {
  const gb = deviceMemoryGb();
  const crispFrameBytes = Math.max(1, decodeWidth * decodeHeight * 4);
  const exactBudgetBytes = Math.max(
    clamp(
      Math.round(gb * FRAME_CACHE.EXACT_BUDGET_BYTES_PER_GB),
      FRAME_CACHE.EXACT_BUDGET_BYTES_MIN,
      FRAME_CACHE.EXACT_BUDGET_BYTES_MAX,
    ),
    FRAME_CACHE.MIN_EXACT_SLOTS * crispFrameBytes,
  );
  const aspect =
    decodeWidth > 0 && decodeHeight > 0 ? decodeWidth / decodeHeight : 1;
  const previewHeight = Math.max(1, Math.round(previewWidth / aspect));
  const previewFrameBytes = Math.max(1, previewWidth * previewHeight * 4);
  const previewBudgetBytes = clamp(
    Math.round(gb * FRAME_CACHE.PREVIEW_BUDGET_BYTES_PER_GB),
    FRAME_CACHE.PREVIEW_BUDGET_BYTES_MIN,
    FRAME_CACHE.PREVIEW_BUDGET_BYTES_MAX,
  );
  const previewCapacity = Math.min(
    Math.floor(previewBudgetBytes / previewFrameBytes),
    FRAME_CACHE.PREVIEW_SLOTS_MAX,
  );
  return { exactBudgetBytes, previewCapacity };
}
