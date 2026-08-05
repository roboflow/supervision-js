import type { PlatformMediaFrame } from "supervision-js-core";

import type { MediaFrameProcessorResult } from "../types/frame-processor";

/**
 * The renderer-private unit of presentation. A packet keeps every resource
 * derived from one media frame together, so media, semantic state, and native
 * render handles can never be promoted independently.
 *
 * This is deliberately not exported from a package entry point. Callers pass
 * semantic frames into a session; prepared artifacts belong to its renderer.
 */
export interface PreparedFramePacket<TPayload, TRendererPacket extends object> {
  readonly diagnostics: MediaFrameProcessorResult["diagnostics"];
  readonly frame: PlatformMediaFrame<TPayload>;
  readonly packetId: number;
  readonly rendererPacket: TRendererPacket;
  readonly result: MediaFrameProcessorResult;
}

export function createPreparedFramePacket<
  TPayload,
  TRendererPacket extends object,
>(
  packetId: number,
  frame: PlatformMediaFrame<TPayload>,
  result: MediaFrameProcessorResult,
  rendererPacket: TRendererPacket,
): PreparedFramePacket<TPayload, TRendererPacket> {
  return {
    diagnostics: result.diagnostics,
    frame,
    packetId,
    rendererPacket,
    result,
  };
}
