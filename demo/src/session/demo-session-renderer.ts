import {
  MediaInteractionMode,
  MediaRendererFit,
  RenderPreparationMode,
  type MediaSessionRendererOptions,
} from "supervision";

import { readDemoMaskFrameOptions } from "./mask-raster-resolution";
import { getDemoMaxDevicePixelRatio } from "./render-quality";
import type { DemoSessionCallbacks } from "./demo-session-types";

/** This demo's own policy on when detections answer a pointer. A panel naming it
 *  reads this rather than restating it, so the two cannot drift. */
export const DEMO_INTERACTION_MODE = MediaInteractionMode.PausedOnly;

/** The renderer every demo source opens with, so a fixture and an upload put
 *  the same player on the page. */
export function createDemoRendererOptions(
  options: {
    readonly container: HTMLDivElement;
  } & Pick<
    DemoSessionCallbacks,
    | "onDetectionHover"
    | "onDetectionSelect"
    | "onFrame"
    | "onRendererState"
    | "onRenderPreparationDiagnostics"
    | "onSourceState"
    | "renderQuality"
  >,
): MediaSessionRendererOptions {
  return {
    autoPlay: false,
    // The Frame Time panel and the Frame chip on the always-visible strip read
    // nothing else, and this is what fills them.
    diagnostics: { frameTimings: true },
    fit: MediaRendererFit.Contain,
    interaction: {
      mode: DEMO_INTERACTION_MODE,
      onHover: options.onDetectionHover,
      onSelect: options.onDetectionSelect,
    },
    loop: true,
    maxDevicePixelRatio: getDemoMaxDevicePixelRatio(options.renderQuality),
    onFrame: options.onFrame,
    onState: options.onRendererState,
    renderPreparation: {
      maskFrame: readDemoMaskFrameOptions(
        options.container,
        options.renderQuality,
      ),
      mode: RenderPreparationMode.Worker,
      onDiagnostics: options.onRenderPreparationDiagnostics,
    },
    onSource: options.onSourceState,
  };
}
