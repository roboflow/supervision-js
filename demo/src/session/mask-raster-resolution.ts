import type { RenderPreparationMaskFrameOptions } from "supervision";

import { readDemoDisplayBox } from "./decode-resolution";
import type { DemoRenderQuality } from "./render-quality";

/** `?masks=display` opts one page load into display-sized id rasters. */
const DISPLAY_OVERRIDE = "display";

/**
 * The box the demo paints masks into, for the renderer to cook id rasters at.
 *
 * An id raster is cooked at the detections' own resolution, which can be
 * several times the pixels that reach the screen, and the mask cache holds a
 * fixed number of seconds whatever a raster costs.
 */
export function readDemoMaskFrameOptions(
  container: HTMLElement,
  renderQuality: DemoRenderQuality,
  search: string = globalThis.location?.search ?? "",
): RenderPreparationMaskFrameOptions | undefined {
  if (new URLSearchParams(search).get("masks") !== DISPLAY_OVERRIDE) {
    return undefined;
  }

  // An empty search leaves `?decode=native` to the picture, so a native decode
  // and a display-sized mask can be judged against each other on one page.
  const display = readDemoDisplayBox(container, renderQuality, "");

  return display ? { display } : undefined;
}
