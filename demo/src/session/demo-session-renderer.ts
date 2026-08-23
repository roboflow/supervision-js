import {
  MediaInteractionMode,
  MediaRendererFit,
  RenderPreparationMode,
  type MediaSessionRendererOptions,
} from "supervision";

import { readDemoMaskFrameOptions } from "./mask-raster-resolution";
import { getDemoMaxDevicePixelRatio } from "./render-quality";
import type { DemoSessionCallbacks } from "./demo-session-types";

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
    fit: MediaRendererFit.Contain,
    interaction: {
      mode: MediaInteractionMode.PausedOnly,
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
