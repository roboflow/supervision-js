import { createCBIoUTracker as createInternalCBIoUTracker } from "supervision-js-trackers";
import type {
  CBIoUTracker,
  CBIoUTrackingOptions,
} from "#types/post-processing";

/** Public core facade for the internal tracker engine workspace. */
export function createCBIoUTracker(
  options: CBIoUTrackingOptions = {},
): CBIoUTracker {
  return createInternalCBIoUTracker(options);
}
