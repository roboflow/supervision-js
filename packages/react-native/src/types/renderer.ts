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
 * Operations that do not run on the per-frame path, so they may stay
 * asynchronous even for a worklet-callable adapter.
 */
interface MediaRendererAdapterBase<TPacket extends object> {
  readonly backend: string;
  setPresentation?(presentation: MediaRendererPresentation): void;
  pick?(
    packet: TPacket,
    point: { readonly x: number; readonly y: number },
    options?: DetectionPickOptions,
  ): DetectionPickResult | null;
  destroy?(): void | Promise<void>;
}

/**
 * Renderer adapter boundary. It receives semantic input and returns an opaque
 * prepared packet. Skia images, shader uniforms, shared values, and native
 * handles remain behind this interface.
 *
 * This is the default shape, free to acquire resources asynchronously.
 */
export interface AsyncMediaRendererAdapter<
  TPayload,
  TPacket extends object,
> extends MediaRendererAdapterBase<TPacket> {
  readonly sync?: false;
  prepare(
    options: MediaRendererPrepareOptions<TPayload>,
  ): TPacket | Promise<TPacket>;
  present(packet: TPacket): void | Promise<void>;
  disposePacket?(packet: TPacket): void | Promise<void>;
}

/**
 * A renderer adapter that a worklet pump can drive inline.
 *
 * Every per-frame operation — `prepare`, `present`, and `disposePacket` —
 * must complete without a Promise. This is the renderer half of the
 * worklet-callable contract; see `SyncMediaFrameProcessor` for the producer
 * half. A session whose processor and renderer are both sync runs its whole
 * frame path with no microtask in it.
 *
 * `disposePacket` is included on purpose: the session hands packets to
 * `PreparedFrameStore`, whose `presentNow()`/`discardNow()` throw when a
 * disposer returns a Promise. Declaring `sync: true` while disposing
 * asynchronously would fail at runtime rather than at the type boundary.
 *
 * Implementations intended for a worklet runtime must also mark these methods
 * with the `"worklet"` directive. The type system cannot express that, so it
 * stays a contract note.
 */
export interface SyncMediaRendererAdapter<
  TPayload,
  TPacket extends object,
> extends MediaRendererAdapterBase<TPacket> {
  readonly sync: true;
  prepare(options: MediaRendererPrepareOptions<TPayload>): TPacket;
  present(packet: TPacket): void;
  disposePacket?(packet: TPacket): void;
}

export type MediaRendererAdapter<TPayload, TPacket extends object> =
  | AsyncMediaRendererAdapter<TPayload, TPacket>
  | SyncMediaRendererAdapter<TPayload, TPacket>;

/**
 * Narrows a renderer adapter to the worklet-callable form.
 *
 * Callable from a worklet runtime so a future worklet pump can select the same
 * path the JavaScript-thread session takes.
 */
export function isSyncMediaRendererAdapter<TPayload, TPacket extends object>(
  adapter: MediaRendererAdapter<TPayload, TPacket>,
): adapter is SyncMediaRendererAdapter<TPayload, TPacket> {
  "worklet";

  return adapter.sync === true;
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
