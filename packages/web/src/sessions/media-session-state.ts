import { DetectionBufferStatus } from "supervision-js-core";
import {
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererState,
} from "#types/media-renderer";
import {
  RenderPreparationArtifactFrameStatus,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";
import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
  type MediaSessionActivity,
  type MediaSessionMediaState,
  type MediaSessionNormalizationState,
  type MediaSessionState,
} from "#types/media-session";

export interface MediaSessionStateSnapshotInput {
  readonly errorMessage: string | null;
  readonly media: MediaSessionMediaState;
  readonly normalization: MediaSessionNormalizationState | null;
  readonly renderPreparation: RenderPreparationDiagnostics | null;
  readonly renderer: MediaRendererState | null;
}

export function createMediaSessionStateSnapshot({
  errorMessage,
  media,
  normalization,
  renderPreparation,
  renderer,
}: MediaSessionStateSnapshotInput): MediaSessionState {
  const activities: MediaSessionActivity[] = [];

  if (!renderer) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        blockingPresentation: true,
        kind: MediaSessionActivityKind.MediaOpening,
        label: "Opening media",
        status: MediaSessionActivityStatus.Running,
      }),
    );
  }

  if (normalization?.active) {
    activities.push(
      createActivity({
        kind: MediaSessionActivityKind.MediaNormalizing,
        label: "Normalizing media",
        progress: normalization.progress?.progress,
        status: MediaSessionActivityStatus.Running,
      }),
    );
  }

  if (renderer?.playbackState === MediaRendererPlaybackState.Buffering) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        kind: MediaSessionActivityKind.PlaybackBuffering,
        label: "Buffering playback",
        status: MediaSessionActivityStatus.Waiting,
      }),
    );
  }

  if (renderer?.detectionBuffer.status === DetectionBufferStatus.Loading) {
    const blockingPlayback =
      renderer.playbackState === MediaRendererPlaybackState.Buffering;

    activities.push(
      createActivity({
        blockingPlayback,
        kind: blockingPlayback
          ? MediaSessionActivityKind.DetectionsBuffering
          : MediaSessionActivityKind.DetectionsLoading,
        label: blockingPlayback
          ? "Waiting for detection buffer"
          : "Loading detections",
        status: blockingPlayback
          ? MediaSessionActivityStatus.Waiting
          : MediaSessionActivityStatus.Running,
      }),
    );
  }

  for (const artifact of renderPreparation?.artifacts ?? []) {
    const totalCount = artifact.pendingCount + artifact.preparedCount;
    const activeFrameIsPending =
      artifact.activeFrame?.status ===
      RenderPreparationArtifactFrameStatus.Pending;

    if (artifact.pendingCount <= 0 && !activeFrameIsPending) {
      continue;
    }

    activities.push(
      createActivity({
        artifactKind: artifact.kind,
        blockingPresentation: activeFrameIsPending,
        detail: activeFrameIsPending
          ? `Active frame ${artifact.activeFrame.mediaTime.toFixed(
              3,
            )}s is waiting for ${artifact.kind}`
          : null,
        kind: MediaSessionActivityKind.RenderPreparing,
        label: activeFrameIsPending
          ? "Preparing active render artifact"
          : "Preparing render artifacts",
        pendingCount: artifact.pendingCount,
        preparedCount: artifact.preparedCount,
        progress: totalCount > 0 ? artifact.preparedCount / totalCount : 0,
        status: activeFrameIsPending
          ? MediaSessionActivityStatus.Waiting
          : MediaSessionActivityStatus.Running,
      }),
    );
  }

  if (renderer?.playbackState === MediaRendererPlaybackState.Error) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage: renderer.source.errorMessage,
        kind: MediaSessionActivityKind.Error,
        label: "Renderer error",
        status: MediaSessionActivityStatus.Error,
      }),
    );
  }

  if (errorMessage) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage,
        kind: MediaSessionActivityKind.Error,
        label: "Session error",
        status: MediaSessionActivityStatus.Error,
      }),
    );
  }

  return {
    activities,
    errorMessage: errorMessage ?? renderer?.source.errorMessage ?? null,
    media,
    normalization,
    playbackBlocked: activities.some((activity) => activity.blockingPlayback),
    presentationBlocked: activities.some(
      (activity) => activity.blockingPresentation,
    ),
    renderPreparation,
    renderer,
    status: resolveSessionStatus(renderer, activities, errorMessage),
  };
}

function createActivity(
  activity: Omit<
    MediaSessionActivity,
    "blockingPlayback" | "blockingPresentation"
  > &
    Partial<
      Pick<MediaSessionActivity, "blockingPlayback" | "blockingPresentation">
    >,
): MediaSessionActivity {
  return {
    blockingPlayback: false,
    blockingPresentation: false,
    ...activity,
  };
}

function resolveSessionStatus(
  renderer: MediaRendererState | null,
  activities: readonly MediaSessionActivity[],
  errorMessage: string | null,
) {
  if (
    errorMessage ||
    renderer?.playbackState === MediaRendererPlaybackState.Error ||
    renderer?.source.status === MediaSourceStatus.Error
  ) {
    return MediaSessionStatus.Error;
  }

  if (renderer?.playbackState === MediaRendererPlaybackState.Destroyed) {
    return MediaSessionStatus.Destroyed;
  }

  if (renderer?.playbackState === MediaRendererPlaybackState.Buffering) {
    return MediaSessionStatus.Buffering;
  }

  if (
    !renderer ||
    renderer.playbackState === MediaRendererPlaybackState.Loading
  ) {
    return MediaSessionStatus.Loading;
  }

  if (
    activities.some(
      (activity) =>
        activity.status === MediaSessionActivityStatus.Running &&
        activity.kind !== MediaSessionActivityKind.DetectionsLoading,
    )
  ) {
    return MediaSessionStatus.Processing;
  }

  if (renderer.playbackState === MediaRendererPlaybackState.Playing) {
    return MediaSessionStatus.Playing;
  }

  if (renderer.playbackState === MediaRendererPlaybackState.Paused) {
    return MediaSessionStatus.Paused;
  }

  return MediaSessionStatus.Ready;
}
