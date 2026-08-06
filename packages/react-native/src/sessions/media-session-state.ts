import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
  MediaSourceStatus,
  type MediaTimelineMetadata,
} from "supervision-js-core";

import type { MediaSessionCapabilities } from "../types/frame-source";
import type {
  MediaSessionError,
  MediaSessionMediaState,
  MediaSessionState,
} from "../types/media-session";
import type {
  MediaSessionRendererState,
  MediaSessionRenderPreparationState,
} from "../types/renderer";

export interface MediaSessionStateSnapshotInput {
  readonly activeDetectionFrame: MediaSessionRendererState["activeDetectionFrame"];
  readonly activePacketId: number | null;
  readonly capabilities: MediaSessionCapabilities;
  readonly destroyed: boolean;
  readonly ended: boolean;
  readonly error: MediaSessionError | null;
  readonly lastDiagnostics: MediaSessionRenderPreparationState["lastDiagnostics"];
  readonly mode: MediaSessionMode;
  readonly opened: boolean;
  readonly playing: boolean;
  readonly presentedFrames: number;
  readonly preparedFrames: number;
  readonly processing: boolean;
  readonly rendererBackend: string;
  readonly started: boolean;
  readonly stopped: boolean;
  readonly timeline: MediaTimelineMetadata;
}

/** Creates one complete mobile lifecycle snapshot from renderer-neutral state. */
export function createMediaSessionStateSnapshot(
  input: MediaSessionStateSnapshotInput,
): MediaSessionState {
  const activities = [];

  if (!input.opened) {
    activities.push({
      blockingPlayback: true,
      blockingPresentation: true,
      kind: MediaSessionActivityKind.MediaOpening,
      label: "Opening media",
      status: MediaSessionActivityStatus.Running,
    });
  }

  if (input.processing) {
    activities.push({
      artifactKind: "mobile-frame",
      blockingPlayback: input.mode !== MediaSessionMode.Stream,
      blockingPresentation: true,
      kind: MediaSessionActivityKind.RenderPreparing,
      label: "Preparing frame",
      pendingCount: 1,
      preparedCount: input.preparedFrames,
      status: MediaSessionActivityStatus.Running,
    });
  }

  if (input.error) {
    activities.push({
      blockingPlayback: true,
      blockingPresentation: true,
      errorMessage: input.error.message,
      kind: MediaSessionActivityKind.Error,
      label: "Media session error",
      status: MediaSessionActivityStatus.Error,
    });
  }

  const media: MediaSessionMediaState = {
    capabilities: input.capabilities,
    error: input.error
      ? {
          code: input.error.code,
          message: input.error.message,
          stage: input.error.stage,
        }
      : null,
    opened: input.opened,
    sourceStatus: resolveSourceStatus(input),
    timeline: input.timeline,
  };

  return {
    activities,
    errorMessage: input.error?.message ?? null,
    media,
    normalization: null,
    playbackBlocked: activities.some((activity) => activity.blockingPlayback),
    presentationBlocked: activities.some(
      (activity) => activity.blockingPresentation,
    ),
    renderPreparation: {
      activePacketId: input.activePacketId,
      lastDiagnostics: input.lastDiagnostics,
      preparedFrames: input.preparedFrames,
    },
    renderer: {
      activeDetectionFrame: input.activeDetectionFrame,
      backend: input.rendererBackend,
      presentedFrames: input.presentedFrames,
    },
    status: resolveSessionStatus(input),
  };
}

function resolveSessionStatus(input: MediaSessionStateSnapshotInput) {
  if (input.destroyed) {
    return MediaSessionStatus.Destroyed;
  }

  if (input.error) {
    return MediaSessionStatus.Error;
  }

  if (!input.opened) {
    return MediaSessionStatus.Loading;
  }

  if (input.processing) {
    return MediaSessionStatus.Processing;
  }

  if (input.playing) {
    return MediaSessionStatus.Playing;
  }

  if (input.stopped || input.ended) {
    return MediaSessionStatus.Ready;
  }

  return input.started && input.capabilities.pausable
    ? MediaSessionStatus.Paused
    : MediaSessionStatus.Ready;
}

function resolveSourceStatus(input: MediaSessionStateSnapshotInput) {
  if (input.destroyed) {
    return MediaSourceStatus.Destroyed;
  }

  if (input.error?.stage === "source" || input.error?.stage === "source-open") {
    return MediaSourceStatus.Error;
  }

  return input.opened ? MediaSourceStatus.Ready : MediaSourceStatus.Loading;
}
