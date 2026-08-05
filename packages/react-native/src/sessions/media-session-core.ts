import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
  type MediaRendererPresentation,
  type PlatformMediaFrame,
} from "supervision-js-core";

import type { MediaFrameSourceConsumer } from "../types/frame-source";
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
  let activePacket: TPacket | null = null;
  let activeDetectionFrame: MediaSessionRendererState["activeDetectionFrame"] =
    null;
  let activePacketId: number | null = null;
  let error: MediaSessionError | null = null;
  let presentation = options.presentation ?? {};
  let presentedFrames = 0;
  let preparedFrames = 0;
  let nextPacketId = 0;
  let processing = false;
  let playing = false;
  let stopped = false;
  let destroyPromise: Promise<void> | null = null;
  let frameQueue: Promise<void> = Promise.resolve();
  let lastDiagnostics: MediaSessionRenderPreparationState["lastDiagnostics"] =
    null;

  const state = (): MediaSessionState => {
    const activities = [];

    if (!opened) {
      activities.push({
        blockingPlayback: true,
        blockingPresentation: true,
        kind: MediaSessionActivityKind.MediaOpening,
        label: "Opening media",
        status: MediaSessionActivityStatus.Running,
      });
    }

    if (processing) {
      activities.push({
        artifactKind: "mobile-frame",
        blockingPlayback: options.source.mode !== MediaSessionMode.Stream,
        blockingPresentation: true,
        kind: MediaSessionActivityKind.RenderPreparing,
        label: "Preparing frame",
        pendingCount: 1,
        preparedCount: preparedFrames,
        status: MediaSessionActivityStatus.Running,
      });
    }

    if (error) {
      activities.push({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage: error.message,
        kind: MediaSessionActivityKind.Error,
        label: "Media session error",
        status: MediaSessionActivityStatus.Error,
      });
    }

    const status = error
      ? MediaSessionStatus.Error
      : destroyed
        ? MediaSessionStatus.Destroyed
        : !opened
          ? MediaSessionStatus.Loading
          : processing
            ? MediaSessionStatus.Processing
            : playing
              ? MediaSessionStatus.Playing
              : started && options.source.capabilities.pausable
                ? MediaSessionStatus.Paused
                : MediaSessionStatus.Ready;

    return {
      activities,
      errorMessage: error?.message ?? null,
      media: {
        capabilities: options.source.capabilities,
        opened,
        timeline: options.source.timeline,
      },
      normalization: null,
      playbackBlocked: activities.some((activity) => activity.blockingPlayback),
      presentationBlocked: activities.some(
        (activity) => activity.blockingPresentation,
      ),
      renderPreparation: {
        activePacketId,
        lastDiagnostics,
        preparedFrames,
      },
      renderer: {
        activeDetectionFrame,
        backend: options.renderer.backend,
        presentedFrames,
      },
      status,
    };
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

  const disposePacket = async (packet: TPacket | null) => {
    if (packet) {
      await options.renderer.disposePacket?.(packet);
    }
  };

  const onFrame = async (frame: PlatformMediaFrame<TPayload>) => {
    if (destroyed || stopped || error) {
      return;
    }

    processing = true;
    emit();

    let nextPacket: TPacket | null = null;
    let stage: "processor" | "renderer" = "processor";

    try {
      const result = await options.processor.process(frame);
      const packetId = nextPacketId;

      nextPacketId += 1;
      stage = "renderer";
      nextPacket = await options.renderer.prepare({
        frame,
        packetId,
        presentation,
        result,
      });
      await options.renderer.present(nextPacket);
      const previousPacket = activePacket;

      activePacket = nextPacket;
      activePacketId = packetId;
      activeDetectionFrame = result.detectionFrame;
      lastDiagnostics = result.diagnostics ?? null;
      preparedFrames += 1;
      presentedFrames += 1;
      nextPacket = null;
      await disposePacket(previousPacket);
    } catch (cause) {
      await disposePacket(nextPacket);
      reportError(
        stage === "processor" ? "processor-failed" : "renderer-failed",
        cause,
      );
    } finally {
      processing = false;
      emit();
    }
  };

  const consumer: MediaFrameSourceConsumer<TPayload> = {
    onEnd() {
      if (destroyed || stopped || error) {
        return;
      }

      playing = false;
      emit();
    },
    onError(cause) {
      reportError("source-failed", cause);
    },
    onFrame(frame) {
      frameQueue = frameQueue.then(() => onFrame(frame));
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
    void Promise.resolve()
      .then(() => options.source.start(consumer))
      .catch((cause) => {
        reportError("source-failed", cause);
      });
  } catch (cause) {
    reportError("source-open-failed", cause);
    await destroyResources();
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
      destroyPromise = destroyResources().finally(() => {
        emit();
        listeners.clear();
      });
      return destroyPromise;
    },
    getState: state,
    pause() {
      assertActive("pause");
      assertCapability("pause", options.source.capabilities.pausable);
      options.source.pause?.();
      playing = false;
      emit();
    },
    pick(point, pickOptions) {
      assertActive("pick");

      return activePacket && options.renderer.pick
        ? options.renderer.pick(activePacket, point, pickOptions)
        : null;
    },
    async play() {
      assertActive("play");
      assertCapability("play", options.source.capabilities.pausable);
      await options.source.resume?.();
      stopped = false;
      playing = true;
      emit();
    },
    async seek(mediaTime) {
      assertActive("seek");
      assertCapability("seek", options.source.capabilities.seekable);
      await options.source.seek?.(mediaTime);
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
      stopped = true;
      playing = false;
      options.source.stop?.();
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
    const packet = activePacket;

    activePacket = null;
    activePacketId = null;
    activeDetectionFrame = null;
    await disposePacket(packet);
    await options.source.destroy?.();
    await options.renderer.destroy?.();
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
