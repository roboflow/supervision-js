import {
  MediaInteractionMode,
  MediaRendererFit,
  type MediaSessionRendererOptions,
} from "supervision";

import { DemoViewMode, readStoredDemoViewMode } from "./demo-view-mode";
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
    // Timing every layer of every present costs about ten points of process CPU
    // on a 120Hz display, so only the view that reads the numbers pays for them.
    diagnostics: {
      frameTimings:
        readStoredDemoViewMode(DemoViewMode.Demo) === DemoViewMode.Debug,
    },
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
      onDiagnostics: options.onRenderPreparationDiagnostics,
    },
    onSource: options.onSourceState,
  };
}
