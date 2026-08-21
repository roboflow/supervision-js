import type { DisplayBoxResolutionOptions } from "supervision-js-video-engine";
import {
  getDemoMaxDevicePixelRatio,
  type DemoRenderQuality,
} from "./render-quality";

/** `?decode=native` opts one page load back out, for judging the difference. */
const NATIVE_OVERRIDE = "native";

/**
 * The box the demo composites video into, for the engine to decode at.
 *
 * The demo runs the engine canvas-less, so the engine has no display box of its
 * own to measure and decodes at the source's full resolution until this says
 * otherwise. A phone-shaped source in a laptop-shaped stage then decodes several
 * times the pixels that reach the screen, and the scrub cache holds proportionally
 * fewer frames, since a slot costs whatever a decoded frame costs.
 *
 * The pixel-ratio ceiling is the render quality the canvas backing store is
 * already sized by, so the decode lands on the same pixel grid the picture is
 * painted at: never coarser, which would show, and never finer, which nobody
 * can see.
 *
 * Returns undefined when the stage has not been laid out, or when the URL asks
 * for native, and the engine keeps its full-resolution default.
 */
export function readDemoDisplayBox(
  container: HTMLElement,
  renderQuality: DemoRenderQuality,
  search: string = globalThis.location?.search ?? "",
): DisplayBoxResolutionOptions | undefined {
  if (new URLSearchParams(search).get("decode") === NATIVE_OVERRIDE) {
    return undefined;
  }

  const box = container.getBoundingClientRect();

  if (!(box.width > 0) || !(box.height > 0)) {
    return undefined;
  }

  const devicePixelRatio = globalThis.devicePixelRatio || 1;

  return {
    boxWidth: box.width,
    boxHeight: box.height,
    devicePixelRatio,
    maxDevicePixelRatio:
      getDemoMaxDevicePixelRatio(renderQuality) ?? devicePixelRatio,
  };
}
