import { DetectionBufferStatus } from "supervision-js-core";
import {
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererState,
} from "#types/media-renderer";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationGateHoldReason,
  type RenderPreparationArtifactDiagnostics,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";
import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMediaBranch,
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
  const awaitingSourceRead = renderer?.source.awaitingRead === true;
  const preparingActiveFrame = (renderPreparation?.artifacts ?? []).some(
    (artifact) =>
      artifact.activeFrame?.status ===
        RenderPreparationArtifactFrameStatus.Pending ||
      Boolean(artifact.gateHold),
  );

  if (awaitingSourceRead) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        detail: "The video for this part has not arrived yet",
        kind: MediaSessionActivityKind.MediaSourceReading,
        label: "Loading the video",
        status: MediaSessionActivityStatus.Waiting,
      }),
    );
  }

  // A picture stopped for its annotations is not stopped for its own bytes, and
  // a host shown both reads the vaguer one first and tells the viewer the wrong
  // thing. Only the reason nothing more specific claims is reported here.
  if (
    stoppedForPlayback &&
    !awaitingSourceRead &&
    !awaitingCoverage &&
    !loadingDetections &&
    !preparingActiveFrame
  ) {
    activities.push(
      createActivity({
        blockingPlayback: true,
        detail: playbackBufferingDetail(media),
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
    const gateHold = artifact.gateHold ?? null;
    const leadHold =
      gateHold?.reason === RenderPreparationGateHoldReason.LeadBelowRequirement
        ? gateHold
        : null;
    // The gate holds the frame about to be presented, which is not the frame on
    // screen: a hold can name an unprepared frame ahead while the presented one
    // is prepared and the queue behind it is empty. Reading only those two says
    // nothing at all, and the picture stops with no activity to explain it.
    const waitingForFrame =
      activeFrameIsPending || (gateHold !== null && leadHold === null);

    if (
      artifact.pendingCount <= 0 &&
      !activeFrameIsPending &&
      gateHold === null
    ) {
      continue;
    }

    const holdingPlayback =
      (activeFrameIsPending || gateHold !== null) && stoppedForPlayback;
    const waiting = activeFrameIsPending || gateHold !== null;

    activities.push(
      createActivity({
        artifactKind: artifact.kind,
        blockingPlayback: holdingPlayback,
        blockingPresentation: activeFrameIsPending,
        detail: leadHold
          ? `Starting again at ${leadHold.requiredAheadSeconds.toFixed(
              1,
            )}s of masks ready`
          : holdingPlayback && waitingForFrame
            ? "The masks for this frame are not drawn yet"
            : activeFrameIsPending
              ? `Active frame ${artifact.activeFrame.mediaTime.toFixed(
                  3,
                )}s is waiting for ${artifact.kind}`
              : null,
        kind: MediaSessionActivityKind.RenderPreparing,
        label: leadHold
          ? "Catching the masks up"
          : waitingForFrame
            ? holdingPlayback
              ? "Waiting for the masks"
              : "Preparing active render artifact"
            : "Preparing render artifacts",
        pendingCount: artifact.pendingCount,
        preparedCount: artifact.preparedCount,
        progress: leadHold
          ? leadProgress(artifact)
          : totalCount > 0
            ? artifact.preparedCount / totalCount
            : 0,
        status: waiting
          ? MediaSessionActivityStatus.Waiting
          : MediaSessionActivityStatus.Running,
      }),
    );
  }

  if (renderer?.renderPreparationGateAbandoned === true) {
    activities.push(
      createActivity({
        detail: "The video is playing without them",
        kind: MediaSessionActivityKind.RenderPreparationAbandoned,
        label: "Masks could not keep up",
        status: MediaSessionActivityStatus.Waiting,
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

/**
 * Why the picture is short of video, in terms the session can stand behind.
 *
 * A transfer is certain on one branch only. A file opened from the device, and
 * a source the host built and the session cannot see into, both stop while the
 * bytes are read and decoded with nothing arriving over a network, so naming a
 * download there describes an event that cannot happen.
 */
function playbackBufferingDetail(media: MediaSessionMediaState) {
  return media.preparation?.branch === MediaSessionMediaBranch.Url
    ? "This part of the video has not downloaded yet"
    : "This part of the video is still being read";
}

/** How far a lead the gate is banking has come, against what it has to reach. */
function leadProgress(artifact: RenderPreparationArtifactDiagnostics) {
  const requiredAheadSeconds = artifact.gateHold?.requiredAheadSeconds ?? 0;

  if (requiredAheadSeconds <= 0) {
    return 0;
  }

  return Math.min(
    (artifact.preparedAheadSeconds ?? 0) / requiredAheadSeconds,
    1,
  );
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
