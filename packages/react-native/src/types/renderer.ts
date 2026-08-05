import type {
  DetectionFrame,
  DetectionPickOptions,
  DetectionPickResult,
  MediaRendererPresentation,
  PlatformMediaFrame,
} from "supervision-js-core";

import type { MediaFrameProcessorResult } from "./frame-processor";

/** Opaque packet created and owned by a renderer adapter. */
export type PreparedMediaFramePacket = object;

export interface MediaRendererPrepareOptions<TPayload> {
  readonly frame: PlatformMediaFrame<TPayload>;
  readonly packetId: number;
  readonly presentation: MediaRendererPresentation;
  readonly result: MediaFrameProcessorResult;
}

/**
 * Renderer adapter boundary. It receives semantic input and returns an opaque
 * prepared packet. Skia images, shader uniforms, shared values, and native
 * handles remain behind this interface.
 */
export interface MediaRendererAdapter<TPayload, TPacket extends object> {
  readonly backend: string;
  prepare(
    options: MediaRendererPrepareOptions<TPayload>,
  ): TPacket | Promise<TPacket>;
  present(packet: TPacket): void | Promise<void>;
  disposePacket?(packet: TPacket): void | Promise<void>;
  setPresentation?(presentation: MediaRendererPresentation): void;
  pick?(
    packet: TPacket,
    point: { readonly x: number; readonly y: number },
    options?: DetectionPickOptions,
  ): DetectionPickResult | null;
  destroy?(): void | Promise<void>;
}

export interface MediaSessionRendererState {
  readonly activeDetectionFrame: DetectionFrame | null;
  readonly backend: string;
  readonly presentedFrames: number;
}

export interface MediaSessionRenderPreparationState {
  readonly activePacketId: number | null;
  readonly lastDiagnostics: Readonly<
    Record<string, number | string | boolean>
  > | null;
  readonly preparedFrames: number;
}
