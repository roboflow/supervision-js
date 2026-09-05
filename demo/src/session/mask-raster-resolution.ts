import type { RenderPreparationMaskFrameOptions } from "supervision";

import { readDemoDisplayBox } from "./decode-resolution";
import type { DemoRenderQuality } from "./render-quality";

/** `?masks=native` returns one page load to detection-sized id rasters. */
const NATIVE_OVERRIDE = "native";

/**
 * The box the demo paints masks into, for the renderer to cook id rasters at.
 *
 * An id raster holds a detection id per pixel, so it can only ever be sampled
 * nearest: blending two ids names a third detection. A raster cooked larger
 * than the box it is drawn into therefore discards whole texels rather than
 * averaging them, which ragged the mask edges and made them crawl during
 * playback. Cooking at the box gives one texel per pixel.
 */
export function readDemoMaskFrameOptions(
  container: HTMLElement,
  renderQuality: DemoRenderQuality,
  search: string = globalThis.location?.search ?? "",
): RenderPreparationMaskFrameOptions | undefined {
  if (new URLSearchParams(search).get("masks") === NATIVE_OVERRIDE) {
    return undefined;
  }

  // An empty search leaves `?decode=native` to the picture, so a native decode
  // and a display-sized mask can be judged against each other on one page.
  const display = readDemoDisplayBox(container, renderQuality, "");

  return display ? { display } : undefined;
}
