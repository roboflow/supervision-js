import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
  type MediaSessionActivity,
  type MediaSessionState,
} from "supervision";

import type {
  DemoMediaState,
  UploadInferenceState,
} from "../session/demo-session-types";
import { formatExactTime } from "../format";
import { mediaFailureHeadline } from "./media-failure-copy";

/**
 * The picture never waits for these, so they read as background progress rather
 * than as conditions the viewer has to sit through. The control bar reports
 * them: buffering on the play button and in the state chip, the prepared window
 * and the detection buffer in their own timeline lanes.
 */
export const BACKGROUND_ACTIVITY_KINDS: ReadonlySet<MediaSessionActivityKind> =
  new Set([
    MediaSessionActivityKind.DetectionsBuffering,
    MediaSessionActivityKind.DetectionsLoading,
    MediaSessionActivityKind.PlaybackBuffering,
    MediaSessionActivityKind.RenderPreparing,
  ]);

export function selectViewportSessionState(
  sessionState: MediaSessionState | null,
): MediaSessionState | null {
  if (sessionState === null) {
    return null;
  }

  const activities = sessionState.activities.filter(
    (activity) => !BACKGROUND_ACTIVITY_KINDS.has(activity.kind),
  );

  return activities.length === sessionState.activities.length
    ? sessionState
    : { ...sessionState, activities };
}

export function sameViewportOverlay(
  previousOverlay: ViewportOverlay | null,
  nextOverlay: ViewportOverlay | null,
) {
  if (previousOverlay === nextOverlay) {
    return true;
  }

  if (!previousOverlay || !nextOverlay) {
    return false;
  }

  return (
    previousOverlay.detail === nextOverlay.detail &&
    previousOverlay.kicker === nextOverlay.kicker &&
    previousOverlay.label === nextOverlay.label &&
    previousOverlay.progress === nextOverlay.progress &&
    previousOverlay.tone === nextOverlay.tone
  );
}

export interface ViewportOverlay {
  readonly detail: string | null;
  readonly kicker: string;
  readonly label: string;
  readonly progress: number | null;
  readonly tone: "active" | "error" | "waiting";
}

export function createViewportOverlay(
  sessionState: MediaSessionState | null,
  uploadInferenceState: UploadInferenceState | null,
  mediaState: DemoMediaState,
): ViewportOverlay | null {
  const activity = selectViewportActivity(sessionState);

  if (activity) {
    return {
      detail: formatActivityDetail(activity),
      kicker: formatSessionStatus(sessionState?.status ?? null),
      label: mediaFailureHeadline(activity.errorKind) ?? activity.label,
      progress: activity.progress ?? null,
      tone:
        activity.status === MediaSessionActivityStatus.Error
          ? "error"
          : activity.status === MediaSessionActivityStatus.Waiting
            ? "waiting"
            : "active",
    };
  }

  const seekTarget = selectSeekTarget(sessionState);

  if (seekTarget !== null) {
    return {
      detail: `Moving to ${formatExactTime(seekTarget)}`,
      kicker: "Seeking",
      label: "Finding the frame",
      progress: null,
      tone: "waiting",
    };
  }

  if (
    uploadInferenceState &&
    (uploadInferenceState.status === "preparing" ||
      uploadInferenceState.status === "running")
  ) {
    return {
      detail:
        uploadInferenceState.totalFrames > 0
          ? `${uploadInferenceState.completedFrames}/${uploadInferenceState.totalFrames} frames`
          : null,
      kicker: "Inference",
      label: uploadInferenceState.statusLabel,
      progress:
        uploadInferenceState.totalFrames > 0
          ? uploadInferenceState.completedFrames /
            uploadInferenceState.totalFrames
          : null,
      tone: "active",
    };
  }

  if (!sessionState && mediaState.status) {
    return {
      detail: mediaState.errorMessage,
      kicker: mediaState.errorMessage ? "Error" : "Loading",
      label: mediaState.status,
      progress: null,
      tone: mediaState.errorMessage ? "error" : "active",
    };
  }

  return null;
}

/**
 * A seek moves the playhead at once and the picture follows whenever the frame
 * decodes, and no activity is reported for the gap. `playbackState` cannot
 * stand in: it keeps reporting whatever the transport settled on before the
 * seek, so a wait of any length reads as paused or playing.
 */
function selectSeekTarget(sessionState: MediaSessionState | null) {
  return sessionState?.renderer?.seeking
    ? sessionState.renderer.currentTime
    : null;
}

function selectViewportActivity(sessionState: MediaSessionState | null) {
  if (!sessionState) {
    return null;
  }

  return (
    sessionState.activities.find(isErrorActivity) ??
    selectPreRendererNormalization(sessionState) ??
    sessionState.activities.find((activity) => activity.blockingPlayback) ??
    sessionState.activities.find((activity) => activity.blockingPresentation) ??
    sessionState.activities.find(isForegroundActivity) ??
    null
  );
}

/**
 * Media that needs normalizing is normalized before there is a renderer to show
 * it, so the session reports opening media for the whole of that wait as well.
 * Only one of the two can say how far along it is. Once the picture is up, a
 * progressive normalization runs behind it and is background again.
 */
function selectPreRendererNormalization(sessionState: MediaSessionState) {
  if (sessionState.renderer) {
    return null;
  }

  return (
    sessionState.activities.find(
      (activity) => activity.kind === MediaSessionActivityKind.MediaNormalizing,
    ) ?? null
  );
}

function isErrorActivity(activity: MediaSessionActivity) {
  return activity.status === MediaSessionActivityStatus.Error;
}

function isForegroundActivity(activity: MediaSessionActivity) {
  return (
    activity.kind !== MediaSessionActivityKind.DetectionsLoading &&
    activity.kind !== MediaSessionActivityKind.MediaNormalizing &&
    activity.kind !== MediaSessionActivityKind.RenderPreparing
  );
}

function formatActivityDetail(activity: MediaSessionActivity) {
  if (
    activity.pendingCount !== undefined &&
    activity.preparedCount !== undefined
  ) {
    return `${activity.preparedCount} ready, ${activity.pendingCount} pending`;
  }

  if (activity.errorMessage) {
    return activity.errorMessage;
  }

  if (activity.detail) {
    return activity.detail;
  }

  return null;
}

function formatSessionStatus(status: MediaSessionStatus | null) {
  if (!status) {
    return "Session";
  }

  if (status === MediaSessionStatus.Buffering) {
    return "Waiting";
  }

  if (status === MediaSessionStatus.Loading) {
    return "Loading";
  }

  if (status === MediaSessionStatus.Error) {
    return "Error";
  }

  return "Processing";
}
