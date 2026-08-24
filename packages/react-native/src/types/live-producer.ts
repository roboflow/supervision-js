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
 * See `SyncMediaFrameProcessor` for the session-level equivalent.
 *
 * ## What the live lane accepts
 *
 * Two narrowings apply here that do not apply to a `DetectionFrame` generally,
 * both because this runs per frame on a camera thread:
 *
 * - **Only `DenseBitmapDetectionMask` is drawn.** An RLE mask is cold storage;
 *   decoding one per detection per frame is exactly the cost the dense encoding
 *   exists to avoid. RLE masks are skipped and reported through the readout's
 *   `skippedRleMaskCount`, so a producer can tell that its masks are not
 *   reaching the screen.
 * - **Geometry is trusted, not validated.** Mask `data.length` is assumed to be
 *   `width * height`, and keypoint edge indices are assumed to be in range
 *   (out-of-range edges are dropped rather than drawn). Core's
 *   `validateDetectionFrames()` enforces these on the cold path; the hot path
 *   cannot afford a per-frame pass, so holding the invariant is the adapter's
 *   job.
 */
export interface ReactNativeLiveDetectionProducer {
  process(frame: unknown): DetectionFrame;
}
