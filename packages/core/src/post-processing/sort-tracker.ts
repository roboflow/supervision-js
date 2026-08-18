import { createSortTracker as createInternalSortTracker } from "supervision-js-trackers";
import type { SortTracker, SortTrackingOptions } from "#types/post-processing";

/** Public core facade for the internal tracker engine workspace. */
export function createSortTracker(
  options: SortTrackingOptions = {},
): SortTracker {
  return createInternalSortTracker(options);
}
