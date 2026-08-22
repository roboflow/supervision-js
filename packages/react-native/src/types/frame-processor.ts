import type { DetectionFrame, PlatformMediaFrame } from "supervision-js-core";

/**
 * Semantic result of processing one media frame. Renderer-specific artifacts
 * are deliberately absent: processors describe detections, while the renderer
 * prepares the resources it needs for presentation.
 */
export interface MediaFrameProcessorResult {
  readonly detectionFrame: DetectionFrame;
  readonly diagnostics?: Readonly<Record<string, number | string | boolean>>;
}

/**
 * A processor that runs on a normal JavaScript runtime and may be
 * asynchronous. This is the default shape: a host that awaits a model call, a
 * network request, or any other Promise implements this.
 */
export interface AsyncMediaFrameProcessor<TPayload> {
  readonly sync?: false;
  process(
    frame: PlatformMediaFrame<TPayload>,
  ): MediaFrameProcessorResult | Promise<MediaFrameProcessorResult>;
}

/**
 * A processor that a worklet pump can call inline.
 *
 * `process()` must return a result directly. A worklet frame callback has no
 * Promise boundary available to it, so a per-frame `await` is not merely slow
 * there — it is unavailable. Declaring `sync: true` is how a host states that
 * its producer is safe to invoke that way; the session then calls it without
 * introducing a microtask between processing and the next cancellation check.
 *
 * Implementations intended for a worklet runtime must also mark `process()`
 * with the `"worklet"` directive so the function can cross the runtime
 * boundary. The type system cannot express that, so it stays a contract note.
 *
 * This mirrors `PreparedFrameStore`'s existing `presentNow()`/`discardNow()`
 * split: the same operation, offered in a form a worklet can reach.
 */
export interface SyncMediaFrameProcessor<TPayload> {
  readonly sync: true;
  process(frame: PlatformMediaFrame<TPayload>): MediaFrameProcessorResult;
}

/**
 * A frame processor may run on a normal JavaScript runtime or be supplied by a
 * worklet-aware source adapter. The package never owns a model runtime.
 */
export type MediaFrameProcessor<TPayload> =
  AsyncMediaFrameProcessor<TPayload> | SyncMediaFrameProcessor<TPayload>;

/**
 * Narrows a processor to the worklet-callable form.
 *
 * Callable from a worklet runtime so a future worklet pump can select the same
 * path the JavaScript-thread session takes.
 */
export function isSyncMediaFrameProcessor<TPayload>(
  processor: MediaFrameProcessor<TPayload>,
): processor is SyncMediaFrameProcessor<TPayload> {
  "worklet";

  return processor.sync === true;
}
