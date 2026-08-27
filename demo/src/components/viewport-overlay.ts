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
import { mediaFailureHeadline } from "./media-failure-copy";

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

function selectViewportActivity(sessionState: MediaSessionState | null) {
  if (!sessionState) {
    return null;
  }

  return (
    sessionState.activities.find((activity) => activity.blockingPlayback) ??
    sessionState.activities.find((activity) => activity.blockingPresentation) ??
    sessionState.activities.find(
      (activity) => activity.status === MediaSessionActivityStatus.Error,
    ) ??
    sessionState.activities.find(isForegroundActivity) ??
    null
  );
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
