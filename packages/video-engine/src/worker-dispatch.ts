import type { EngineCore } from "./engine-core";
import { VideoEngineError, VideoEngineErrorCode } from "./types";
import {
  type EngineCommand,
  type EngineEvent,
  type RequestId,
  type ResponseEvent,
  type SerializedEngineError,
  serializeEngineError,
} from "./worker-protocol";

/**
 * Command router for the engine worker, split out from the worker entry so it
 * can be exercised directly: the entry runs `self`-scoped side effects at module
 * load and so cannot be imported outside a worker realm, but this function takes
 * its collaborators as arguments, so a test can host a real EngineCore behind a
 * fake port.
 *
 * Each posted EngineCommand maps to one EngineCore method. Fire-and-forget
 * commands post nothing; awaitable ones post exactly one terminal ResponseEvent
 * carrying their requestId (the builder's success event, or an error event if
 * the engine throws). MirrorEvents leave separately through EngineCore's emit.
 */
export type PostEngineEvent = (event: EngineEvent) => void;

function toSerializedError(error: unknown): SerializedEngineError {
  if (error instanceof VideoEngineError) return serializeEngineError(error);
  return {
    code: VideoEngineErrorCode.BackendCrashed,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function settle(
  post: PostEngineEvent,
  requestId: RequestId,
  run: () => Promise<ResponseEvent> | ResponseEvent,
): Promise<void> {
  try {
    post(await run());
  } catch (error) {
    post({ type: "error", requestId, error: toSerializedError(error) });
  }
}

export async function handleEngineCommand(
  engine: EngineCore,
  command: EngineCommand,
  post: PostEngineEvent,
): Promise<void> {
  switch (command.type) {
    case "bindCanvas":
      engine.setCanvas(command.canvas, command.viewport);
      return;
    case "unbindCanvas":
      engine.setCanvas(null);
      return;
    case "scrub":
      engine.scrub(command.frameIndex, command.intent);
      return;
    case "pause":
      engine.pause();
      return;
    case "togglePlayback":
      engine.togglePlayback();
      return;
    case "beginInteractiveSeek":
      engine.beginInteractiveSeek();
      return;
    case "setPlaybackRate":
      engine.setPlaybackRate(command.rate);
      return;
    case "diagnosticsStart":
      engine.diagnosticsStart(command.hz);
      return;
    case "diagnosticsStop":
      engine.diagnosticsStop();
      return;
    case "traceArm":
      engine.traceArm(command.windowMs);
      return;
    case "traceDisarm":
      engine.traceDisarm();
      return;
    case "load":
      return settle(post, command.requestId, async () => ({
        type: "ready",
        requestId: command.requestId,
        metadata: await engine.load(command.config),
      }));
    case "play":
      return settle(post, command.requestId, () => {
        engine.play();
        return { type: "ack", requestId: command.requestId };
      });
    case "commit":
      return settle(post, command.requestId, async () => {
        const landing = await engine.commit(command.frameIndex);
        return {
          type: "ack",
          requestId: command.requestId,
          landing: landing ?? undefined,
        };
      });
    case "seekToKey":
      return settle(post, command.requestId, async () => {
        const landing = await engine.seekToKey(command.timeMs);
        return {
          type: "ack",
          requestId: command.requestId,
          landing: landing ?? undefined,
        };
      });
    case "step":
      return settle(post, command.requestId, async () => {
        const landing = await engine.step(command.direction);
        return {
          type: "ack",
          requestId: command.requestId,
          landing: landing ?? undefined,
        };
      });
    case "endInteractiveSeek":
      return settle(post, command.requestId, () => {
        engine.endInteractiveSeek();
        return { type: "ack", requestId: command.requestId };
      });
    case "getStats":
      return settle(post, command.requestId, () => ({
        type: "stats",
        requestId: command.requestId,
        stats: engine.getStats(),
      }));
    case "traceExport":
      return settle(post, command.requestId, () => ({
        type: "traceExport",
        requestId: command.requestId,
        trace: engine.traceExport(),
      }));
    case "dispose":
      return settle(post, command.requestId, async () => {
        await engine.dispose();
        return { type: "ack", requestId: command.requestId };
      });
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}
