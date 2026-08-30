/* What "the demo page is ready to be measured" means, for every scenario in
 * this directory. A window opened under one definition of ready and a window
 * opened under another produce numbers that are not comparable, and nothing
 * downstream of them can tell. */

import { delay } from "./cdp.mjs";

const POLL_MS = 500;
const READY_TIMEOUT_MS = 60_000;

/* The scenario modules sort a disturbed attempt from a real defect with
 * `instanceof Invalid`, so they have to be testing the same class. */
export class Invalid extends Error {}

const PROBE = `(() => {
  const renderer = window.__demoRenderer;
  if (!renderer) return { ready: false, reason: "window.__demoRenderer is absent" };
  const state = renderer.getState();
  if (state.source.status !== "ready" || !(state.duration > 0)) {
    return { ready: false, reason: "media source status " + state.source.status };
  }
  return {
    ready: true,
    duration: state.duration,
    frameRate: state.source.estimatedFrameRate,
    backend: state.rendererBackend,
    mediaWidth: state.mediaWidth,
    mediaHeight: state.mediaHeight,
  };
})()`;

export async function waitForRenderer(session, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    /* A page mid-navigation answers every read with "target navigated or
     * closed", and coming back from that is what this wait is for. */
    last = await session
      .readJson(PROBE)
      .catch((error) => ({ ready: false, reason: error.message }));
    if (last.ready) return last;
    await delay(POLL_MS);
  }
  throw new Invalid(
    `the demo renderer never became ready: ${last?.reason ?? "no response"}`,
  );
}
