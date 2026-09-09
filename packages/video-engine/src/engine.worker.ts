import { EngineCore } from "./engine-core";
import { handleEngineCommand } from "./worker-dispatch";
import type { EngineCommand, EngineEvent } from "./worker-protocol";

/**
 * Worker entry: the only place the three planes meet a real MessagePort. It
 * owns one EngineCore, pipes its MirrorEvent emits straight out, and hands each
 * inbound EngineCommand to the dispatcher. The OffscreenCanvas arrives already
 * transferred on the bindCanvas command and is owned by this realm from then on.
 *
 * DedicatedWorkerGlobalScope is declared in lib.webworker.d.ts, and the engine
 * cannot require a host to load that lib, so the worker global is typed
 * structurally over the members this entry uses. All of them are available under
 * a DOM-only lib set.
 */
type EngineWorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<EngineCommand>) => void,
  ): void;
  postMessage(message: EngineEvent, transfer?: Transferable[]): void;
};

const ctx = globalThis as unknown as EngineWorkerScope;

const engine = new EngineCore({
  emit: (event) => ctx.postMessage(event),
  emitDiagnostics: (event) => ctx.postMessage(event),
  // Its own channel because emit's arrow would silently drop a transfer list:
  // the VideoFrame would be structured-cloned, leaving the worker's copy open
  // and pinning a decoder buffer per paint.
  emitPresentedFrame: (event, transfer) => ctx.postMessage(event, transfer),
});

ctx.addEventListener("message", (event: MessageEvent<EngineCommand>) => {
  void handleEngineCommand(engine, event.data, (out) => ctx.postMessage(out));
});
