import { createOCSortTracker as createInternalOCSortTracker } from "supervision-js-trackers";
import type {
  OCSortTracker,
  OCSortTrackingOptions,
} from "#types/post-processing";

/** Public core facade for the internal tracker engine workspace. */
export function createOCSortTracker(
  options: OCSortTrackingOptions = {},
): OCSortTracker {
  return createInternalOCSortTracker(options);
}
