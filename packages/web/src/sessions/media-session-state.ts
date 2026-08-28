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

  const stoppedForPlayback =
    renderer?.playbackState === MediaRendererPlaybackState.Buffering;
  const awaitingCoverage =
    renderer?.detectionBuffer.status === DetectionBufferStatus.AwaitingCoverage;
  const loadingDetections =
    renderer?.detectionBuffer.status === DetectionBufferStatus.Loading;
  const preparingActiveFrame = (renderPreparation?.artifacts ?? []).some(
    (artifact) =>
      artifact.activeFrame?.status ===
      RenderPreparationArtifactFrameStatus.Pending,
  );

  // A picture stopped for its annotations is not stopped for its own bytes, and
  // a host shown both reads the vaguer one first and tells the viewer the wrong
  // thing. Only the reason nothing more specific claims is reported here.
  if (
    stoppedForPlayback &&
    !awaitingCoverage &&
    !loadingDetections &&
    !preparingActiveFrame
  ) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        detail: "This part of the video has not downloaded yet",
        kind: MediaSessionActivityKind.PlaybackBuffering,
        label: "Waiting for more video",
        status: MediaSessionActivityStatus.Waiting,
      }),
    );
  }

  if (awaitingCoverage) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        detail: "The model has not reached this frame yet",
        kind: MediaSessionActivityKind.DetectionsAwaitingCoverage,
        label: "Waiting for the model",
        status: MediaSessionActivityStatus.Waiting,
      }),
    );
  }

  if (loadingDetections) {
    activities.push(
      createActivity({
        blockingPlayback: stoppedForPlayback,
        detail: stoppedForPlayback
          ? "The detections for this part have not arrived yet"
          : null,
        kind: stoppedForPlayback
          ? MediaSessionActivityKind.DetectionsBuffering
          : MediaSessionActivityKind.DetectionsLoading,
        label: stoppedForPlayback
          ? "Waiting for detections"
          : "Loading detections",
        status: stoppedForPlayback
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

    const holdingPlayback = activeFrameIsPending && stoppedForPlayback;

    activities.push(
      createActivity({
        artifactKind: artifact.kind,
        blockingPlayback: holdingPlayback,
        blockingPresentation: activeFrameIsPending,
        detail: holdingPlayback
          ? "The masks for this frame are not drawn yet"
          : activeFrameIsPending
            ? `Active frame ${artifact.activeFrame.mediaTime.toFixed(
                3,
              )}s is waiting for ${artifact.kind}`
            : null,
        kind: MediaSessionActivityKind.RenderPreparing,
        label: holdingPlayback
          ? "Waiting for the masks"
          : activeFrameIsPending
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
        errorKind: renderer.source.errorKind ?? null,
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
