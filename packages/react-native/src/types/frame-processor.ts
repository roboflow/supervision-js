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
 * A frame processor may run on a normal JavaScript runtime or be supplied by a
 * worklet-aware source adapter. The package never owns a model runtime.
 */
export interface MediaFrameProcessor<TPayload> {
  process(
    frame: PlatformMediaFrame<TPayload>,
  ): MediaFrameProcessorResult | Promise<MediaFrameProcessorResult>;
}
