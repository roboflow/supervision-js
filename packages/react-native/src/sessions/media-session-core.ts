import {
  type MediaRendererPresentation,
  type PlatformMediaFrame,
} from "supervision-js-core";

import type { MediaFrameSourceConsumer } from "../types/frame-source";
import {
  createPreparedFramePacket,
  type PreparedFramePacket,
} from "../renderers/prepared-frame-packet";
import { PreparedFrameStore } from "../renderers/prepared-frame-store";
import { createMediaSessionStateSnapshot } from "./media-session-state";
import {
  MediaSessionError,
  type MediaSession,
  type MediaSessionOptions,
  type MediaSessionState,
  type MediaSessionStateListener,
  type MediaSessionStateUnsubscribe,
} from "../types/media-session";
import type {
  MediaSessionRendererState,
  MediaSessionRenderPreparationState,
} from "../types/renderer";

/**
 * Creates a renderer-owned React Native media session from platform adapters.
 * This core is intentionally free of Skia, React, VisionCamera, Nitro, and
 * model dependencies so its lifecycle can be tested under Node.
 */
export async function createMediaSession<TPayload, TPacket extends object>(
  options: MediaSessionOptions<TPayload, TPacket>,
): Promise<MediaSession> {
  const listeners = new Set<MediaSessionStateListener>();
  let destroyed = false;
  let opened = false;
  let started = false;
  let activeDetectionFrame: MediaSessionRendererState["activeDetectionFrame"] =
    null;
  let activePacketId: number | null = null;
  let error: MediaSessionError | null = null;
  let presentation = options.presentation ?? {};
  let presentedFrames = 0;
  let preparedFrameCount = 0;
  let nextPacketId = 0;
  let processing = false;
  let playing = false;
  let ended = false;
  let stopped = false;
  let playbackIntent = 0;
  let destroyPromise: Promise<void> | null = null;
  let frameQueue: Promise<void> = Promise.resolve();
  let sourceOperationQueue: Promise<void> = Promise.resolve();
  let sourceDestroyAttempted = false;
  const teardownErrors: unknown[] = [];
  let lastDiagnostics: MediaSessionRenderPreparationState["lastDiagnostics"] =
    null;
  const preparedFrameStore = new PreparedFrameStore<
    PreparedFramePacket<TPayload, TPacket>
  >(async (packet) => options.renderer.disposePacket?.(packet.rendererPacket));

  const state = (): MediaSessionState => {
    return createMediaSessionStateSnapshot({
      activeDetectionFrame,
      activePacketId,
      capabilities: options.source.capabilities,
      destroyed,
      ended,
      error,
      lastDiagnostics,
      mode: options.source.mode,
      opened,
      playing,
      presentedFrames,
      preparedFrames: preparedFrameCount,
      processing,
      rendererBackend: options.renderer.backend,
      started,
      stopped,
      timeline: options.source.timeline,
    });
  };

  const emit = () => {
    const snapshot = state();

    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const reportError = (code: MediaSessionError["code"], cause: unknown) => {
    if (destroyed) {
      return;
    }

    error = new MediaSessionError(
      code,
      getErrorMessage(cause, "React Native media session failed."),
      { cause },
    );
    playing = false;
    processing = false;
    emit();
  };

  const onFrame = async (frame: PlatformMediaFrame<TPayload>) => {
    if (shouldAbandonFrame()) {
      return;
    }

    processing = true;
    emit();

    let nextPacket: PreparedFramePacket<TPayload, TPacket> | null = null;
    let stage: "processor" | "renderer" = "processor";

    try {
      const result = await options.processor.process(frame);

      if (shouldAbandonFrame()) {
        return;
      }

      const packetId = nextPacketId;

      nextPacketId += 1;
      stage = "renderer";
      const rendererPacket = await options.renderer.prepare({
        frame,
        packetId,
        presentation,
        result,
      });
      nextPacket = createPreparedFramePacket(
        packetId,
        frame,
        result,
        rendererPacket,
      );

      if (shouldAbandonFrame()) {
        await disposeNextPacket();
        return;
      }

      await options.renderer.present(nextPacket.rendererPacket);

      if (shouldAbandonFrame()) {
        await disposeNextPacket();
        return;
      }

      activePacketId = packetId;
      activeDetectionFrame = result.detectionFrame;
      lastDiagnostics = result.diagnostics ?? null;
      preparedFrameCount += 1;
      presentedFrames += 1;
      await preparedFrameStore.present(nextPacket);
      nextPacket = null;
    } catch (cause) {
      try {
        await disposeNextPacket();
      } catch {
        // Preserve the primary processor/renderer failure as the session error.
      }

      if (destroyed) {
        return;
      }

      reportError(
        stage === "processor" ? "processor-failed" : "renderer-failed",
        cause,
      );
    } finally {
      processing = false;
      emit();
    }

    async function disposeNextPacket() {
      const packet = nextPacket;

      nextPacket = null;
      try {
        if (packet) {
          await preparedFrameStore.discard(packet);
        }
      } catch (cause) {
        if (destroyed) {
          teardownErrors.push(cause);
          return;
        }

        throw cause;
      }
    }
  };

  const consumer: MediaFrameSourceConsumer<TPayload> = {
    onEnd() {
      if (destroyed || stopped || error) {
        return;
      }

      playbackIntent += 1;
      ended = true;
      playing = false;
      emit();
    },
    onError(cause) {
      reportError("source-failed", cause);
    },
    onFrame(frame) {
      if (shouldAbandonFrame()) {
        return;
      }

      frameQueue = frameQueue.then(
        () => onFrame(frame),
        () => onFrame(frame),
      );
      return frameQueue;
    },
  };

  if (options.onState) {
    listeners.add(options.onState);
  }

  emit();

  try {
    await options.source.open?.();
    opened = true;
    playing = true;
    started = true;
    emit();
    await options.source.start(consumer);
  } catch (cause) {
    reportError(opened ? "source-failed" : "source-open-failed", cause);
    try {
      await destroyResources();
    } catch {
      // The source-open error is the useful public failure; cleanup still ran
      // every release attempt before it was ignored here.
    }
    throw (
      error ??
      new MediaSessionError(
        "source-open-failed",
        "Unable to open media source.",
        { cause },
      )
    );
  }

  return {
    capabilities: options.source.capabilities,
    timeline: options.source.timeline,
    destroy() {
      if (destroyed) {
        return destroyPromise ?? Promise.resolve();
      }

      destroyed = true;
      playing = false;
      processing = false;
      destroyPromise = releaseSource()
        .then(() => drainLifecycle())
        .then(() => destroyResources())
        .finally(() => {
          emit();
          listeners.clear();
        });
      return destroyPromise;
    },
    getState: state,
    pause() {
      assertActive("pause");
      assertCapability("pause", options.source.capabilities.pausable);
      playbackIntent += 1;
      void runSourceOperation(() => options.source.pause?.()).catch(
        () => undefined,
      );
      playing = false;
      emit();
    },
    pick(point, pickOptions) {
      assertActive("pick");

      return preparedFrameStore.active && options.renderer.pick
        ? options.renderer.pick(
            preparedFrameStore.active.rendererPacket,
            point,
            pickOptions,
          )
        : null;
    },
    async play() {
      assertActive("play");
      assertCapability("play", options.source.capabilities.pausable);
      const intent = playbackIntent + 1;

      playbackIntent = intent;
      await runSourceOperation(() => options.source.resume?.());

      if (destroyed || error || intent !== playbackIntent) {
        return;
      }

      ended = false;
      stopped = false;
      playing = true;
      emit();
    },
    async seek(mediaTime) {
      assertActive("seek");
      assertCapability("seek", options.source.capabilities.seekable);
      await runSourceOperation(() => options.source.seek?.(mediaTime));
    },
    setPresentation(nextPresentation: MediaRendererPresentation) {
      assertActive("setPresentation");
      presentation = nextPresentation;
      options.renderer.setPresentation?.(presentation);
      emit();
    },
    stop() {
      assertActive("stop");
      assertCapability("stop", options.source.capabilities.stoppable);
      playbackIntent += 1;
      stopped = true;
      playing = false;
      void runSourceOperation(() => options.source.stop?.()).catch(
        () => undefined,
      );
      emit();
    },
    subscribe(listener): MediaSessionStateUnsubscribe {
      listener(state());

      if (destroyed) {
        return () => undefined;
      }

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  async function destroyResources() {
    activePacketId = null;
    activeDetectionFrame = null;

    await runCleanup(() => preparedFrameStore.dispose());
    await releaseSource();
    await runCleanup(() => options.renderer.destroy?.());

    if (teardownErrors.length > 0) {
      throw teardownErrors[0];
    }

    async function runCleanup(cleanup: () => void | Promise<void>) {
      try {
        await cleanup();
      } catch (cause) {
        teardownErrors.push(cause);
      }
    }
  }

  async function releaseSource() {
    if (sourceDestroyAttempted) {
      return;
    }

    sourceDestroyAttempted = true;

    try {
      await options.source.destroy?.();
    } catch (cause) {
      teardownErrors.push(cause);
    }
  }

  async function drainLifecycle() {
    await sourceOperationQueue;
    await frameQueue.catch(() => undefined);
  }

  function enqueueSourceOperation<TValue>(
    operation: () => TValue | Promise<TValue>,
  ) {
    const queuedOperation = sourceOperationQueue.then(() => {
      if (destroyed) {
        throw new MediaSessionError(
          "destroyed",
          "Cannot control media: media session has been destroyed.",
        );
      }

      if (error) {
        throw error;
      }

      return operation();
    });

    sourceOperationQueue = queuedOperation.then(
      () => undefined,
      () => undefined,
    );
    return queuedOperation;
  }

  async function runSourceOperation<TValue>(
    operation: () => TValue | Promise<TValue>,
  ) {
    try {
      return await enqueueSourceOperation(operation);
    } catch (cause) {
      if (cause instanceof MediaSessionError) {
        throw cause;
      }

      reportError("source-failed", cause);
      throw (
        error ??
        new MediaSessionError(
          "source-failed",
          getErrorMessage(cause, "Media source operation failed."),
          { cause },
        )
      );
    }
  }

  function shouldAbandonFrame() {
    return destroyed || !playing || stopped || error !== null;
  }

  function assertActive(operation: string) {
    if (destroyed) {
      throw new MediaSessionError(
        "destroyed",
        `Cannot ${operation}: media session has been destroyed.`,
      );
    }
  }

  function assertCapability(operation: string, supported: boolean) {
    if (!supported) {
      throw new MediaSessionError(
        "unsupported-operation",
        `Cannot ${operation}: this media source does not support it.`,
      );
    }
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}
