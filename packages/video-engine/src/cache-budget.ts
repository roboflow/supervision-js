import { FRAME_CACHE } from "./constants";

/** navigator.deviceMemory reports GB in Chromium alone, and there only in a
 *  secure context. Safari, Firefox and any plain-http page never measure at
 *  all; they take the assumption below. */
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
  readonly previewBudgetBytes: number;
}

/**
 * Sizes both cache tiers to the device's reported RAM and the frame size.
 *
 * The exact tier holds a working set the access pattern fixes in frames, the
 * scrub prefetch window, so its slot floor survives any frame size and the RAM
 * band adds speculative slots on top only while a slot stays cheap. An 8MP
 * source lands on the floor and keeps nothing speculative, which is what holds
 * its resident footprint down. The preview tier's byte ceiling depends on
 * device memory; FrameCache derives its slot count from the actual raster size.
 */
export function resolveCacheBudgets(
  decodeWidth: number,
  decodeHeight: number,
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
  const previewBudgetBytes = clamp(
    Math.round(gb * FRAME_CACHE.PREVIEW_BUDGET_BYTES_PER_GB),
    FRAME_CACHE.PREVIEW_BUDGET_BYTES_MIN,
    FRAME_CACHE.PREVIEW_BUDGET_BYTES_MAX,
  );
  return { exactBudgetBytes, previewBudgetBytes };
}
