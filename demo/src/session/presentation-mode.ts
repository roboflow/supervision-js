import type { PresentationMode } from "supervision-js-web-video-engine";

/** `?presentation=canvas` hands one page load's pixels to the engine itself. */
const CANVAS_OVERRIDE = "canvas";

/**
 * What canvas presentation costs, stated wherever the flag is offered.
 *
 * Binding a canvas transfers the element through `transferControlToOffscreen`,
 * which is one-way: the element keeps no context on this thread for the rest of
 * its life, so no annotation layer can ever draw into it. A canvas-mode page
 * shows video and nothing else.
 */
export const CANVAS_PRESENTATION_NOTICE =
  "The engine owns this canvas. Binding it transferred it to the engine's worker permanently, so nothing on this page can draw over the video: no boxes, no masks, no labels, no picking. That is what the mode is, not something missing from it. Every other page load runs frames presentation, where the engine hands each frame over and the scene composites annotations onto it.";

/**
 * Which side of the engine's presentation fork this page load runs.
 *
 * The demo reaches the engine through `createVideoEngineMediaRendererSource`,
 * whose options type removes `presentation` and pins "frames", so the engine's
 * own default is unreachable from the supported path. This is the door to it:
 * canvas mode is opened by constructing the engine directly and giving it the
 * canvas, which is a different player, not a different setting on this one.
 */
export function readDemoPresentationMode(
  search: string = globalThis.location?.search ?? "",
): PresentationMode {
  return new URLSearchParams(search).get("presentation") === CANVAS_OVERRIDE
    ? "canvas"
    : "frames";
}
