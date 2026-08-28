import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  type MediaSessionActivity,
  type MediaSessionState,
} from "supervision";

import type {
  DemoMediaState,
  UploadInferenceState,
} from "../session/demo-session-types";
import { formatTime } from "../format";
import { mediaFailureHeadline } from "./media-failure-copy";

/**
 * Work that runs behind a moving picture, which reads as background progress
 * rather than as a condition the viewer has to sit through. The control bar
 * reports it: the prepared window and the detection buffer in their own
 * timeline lanes.
 *
 * The same work can also be what stopped the picture, and then it is the
 * viewer's wait and belongs on screen. On a remote source the picture stops for
 * hundreds of milliseconds at a time with nothing else to say so, and the
 * overlay's own delay decides whether any given one lasted long enough to be
 * worth saying.
 */
export const BACKGROUND_ACTIVITY_KINDS: ReadonlySet<MediaSessionActivityKind> =
  new Set([
    MediaSessionActivityKind.DetectionsBuffering,
    MediaSessionActivityKind.DetectionsLoading,
    MediaSessionActivityKind.RenderPreparing,
  ]);

/**
 * The part of the player a wait belongs to, so the headline can say what is
 * being waited for without repeating whose wait it is.
 */
const ACTIVITY_KICKERS: Record<MediaSessionActivityKind, string> = {
  [MediaSessionActivityKind.DetectionsAwaitingCoverage]: "Model",
  [MediaSessionActivityKind.DetectionsBuffering]: "Detections",
  [MediaSessionActivityKind.DetectionsLoading]: "Detections",
  [MediaSessionActivityKind.Error]: "Error",
  [MediaSessionActivityKind.MediaNormalizing]: "Media",
  [MediaSessionActivityKind.MediaOpening]: "Media",
  [MediaSessionActivityKind.PlaybackBuffering]: "Playback",
  [MediaSessionActivityKind.RenderPreparing]: "Masks",
};

export function selectViewportSessionState(
  sessionState: MediaSessionState | null,
): MediaSessionState | null {
  if (sessionState === null) {
    return null;
  }

  const activities = sessionState.activities.filter(
    (activity) =>
      activity.blockingPlayback ||
      !BACKGROUND_ACTIVITY_KINDS.has(activity.kind),
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
    // The picture is held for the model, and how far the model has got is
    // counted elsewhere on the page. Saying it here is what gives the wait an
    // end in sight.
    const inferenceProgress =
      activity.kind === MediaSessionActivityKind.DetectionsAwaitingCoverage
        ? readInferenceProgress(uploadInferenceState)
        : null;

    return {
      detail: inferenceProgress?.detail ?? formatActivityDetail(activity),
      kicker: ACTIVITY_KICKERS[activity.kind],
      label: mediaFailureHeadline(activity.errorKind) ?? activity.label,
      progress: inferenceProgress?.progress ?? activity.progress ?? null,
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
      detail: "Getting that frame ready",
      kicker: "Playback",
      label: `Jumping to ${formatTime(seekTarget)}`,
      progress: null,
      tone: "waiting",
    };
  }

  if (
    uploadInferenceState &&
    (uploadInferenceState.status === "preparing" ||
      uploadInferenceState.status === "running")
  ) {
    const inferenceProgress = readInferenceProgress(uploadInferenceState);

    return {
      detail: inferenceProgress?.detail ?? null,
      kicker: uploadInferenceState.status === "preparing" ? "Media" : "Model",
      label: uploadInferenceState.statusLabel,
      progress: inferenceProgress?.progress ?? null,
      tone: "active",
    };
  }

  if (!sessionState && mediaState.status) {
    return {
      detail: mediaState.errorMessage,
      kicker: mediaState.errorMessage ? "Error" : "Media",
      label: mediaState.status,
      progress: null,
      tone: mediaState.errorMessage ? "error" : "active",
    };
  }

  return null;
}

function readInferenceProgress(
  uploadInferenceState: UploadInferenceState | null,
) {
  if (!uploadInferenceState || uploadInferenceState.totalFrames <= 0) {
    return null;
  }

  const { completedFrames, totalFrames } = uploadInferenceState;

  return {
    detail: `${completedFrames}/${totalFrames} frames`,
    progress: completedFrames / totalFrames,
  };
}

/**
 * A seek moves the playhead at once and the picture follows whenever the frame
 * decodes, and no activity is reported for the gap. `playbackState` cannot
 * stand in: it keeps reporting whatever the transport settled on before the
 * seek, so a wait of any length reads as paused or playing.
 *
 * A drag reports the same landings, and there the playhead is already where the
 * viewer's hand put it: they are leading the picture, not waiting on it.
 */
function selectSeekTarget(sessionState: MediaSessionState | null) {
  const renderer = sessionState?.renderer;

  return renderer?.seeking && !renderer.scrubbing ? renderer.currentTime : null;
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
  if (activity.errorMessage) {
    return activity.errorMessage;
  }

  if (activity.detail) {
    return activity.detail;
  }

  if (
    activity.pendingCount !== undefined &&
    activity.preparedCount !== undefined
  ) {
    return `${activity.preparedCount} ready, ${activity.pendingCount} pending`;
  }

  return null;
}
