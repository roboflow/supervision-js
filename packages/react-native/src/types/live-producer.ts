import type { DetectionFrame } from "supervision-js-core";

/**
 * Vendor-neutral detection producer for the live camera lane.
 *
 * One producer replaces the closed `inferenceMode` enum: instead of the
 * package knowing which task a model performs, the producer returns a
 * `DetectionFrame` and the renderer draws whatever geometry it carries.
 * A detection with a `mask` becomes an ID-mask fill; one with `keypoints`
 * becomes vector markers. Adding a task means adding an adapter, not editing
 * the package.
 *
 * `frame` is the host camera frame, deliberately untyped here. Reading it is
 * the adapter's job, and typing it would pull a camera vendor into this
 * contract. Every model-runtime quirk — argument shape, coordinate repair,
 * mask buffer layout — belongs behind `process()`, so nothing outside
 * `adapters/` needs to know which runtime produced the detections.
 *
 * `process()` is called on the camera frame worklet and must return directly.
 * See {@link SyncMediaFrameProcessor} for the session-level equivalent.
 */
export interface ReactNativeLiveDetectionProducer {
  process(frame: unknown): DetectionFrame;
}
