import { createByteTrackTracker as createInternalByteTrackTracker } from "supervision-js-trackers";
import type {
  ByteTrackTracker,
  ByteTrackTrackingOptions,
} from "#types/post-processing";

/** Public core facade for the internal tracker engine workspace. */
export function createByteTrackTracker(
  options: ByteTrackTrackingOptions = {},
): ByteTrackTracker {
  return createInternalByteTrackTracker(options);
}
