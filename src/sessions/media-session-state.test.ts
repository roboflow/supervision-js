import { describe, expect, it } from "vitest";

import { DetectionBufferStatus } from "#types/detection-timeline";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererState,
} from "#types/media-renderer";
import {
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";
import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
} from "#types/media-session";

import { createMediaSessionStateSnapshot } from "./media-session-state";

describe("media session state", () => {
  it("reports media opening before renderer state is available", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: null,
    });

    expect(state).toMatchObject({
      activities: [
        {
          kind: MediaSessionActivityKind.MediaOpening,
          status: MediaSessionActivityStatus.Running,
        },
      ],
      status: MediaSessionStatus.Loading,
    });
  });

  it("reports blocking detection and render preparation work", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: {
        artifacts: [
          {
            kind: RenderPreparationArtifactKind.MaskFrame,
            pendingCount: 2,
            preparedCount: 6,
          },
        ],
        executionMode: RenderPreparationExecutionMode.Worker,
        message: null,
        workerStatus: RenderPreparationWorkerStatus.Ready,
      },
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Loading,
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    });

    expect(state.status).toBe(MediaSessionStatus.Buffering);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        kind: MediaSessionActivityKind.PlaybackBuffering,
        status: MediaSessionActivityStatus.Waiting,
      }),
      expect.objectContaining({
        blockingPlayback: true,
        kind: MediaSessionActivityKind.DetectionsBuffering,
        status: MediaSessionActivityStatus.Waiting,
      }),
      expect.objectContaining({
        artifactKind: RenderPreparationArtifactKind.MaskFrame,
        kind: MediaSessionActivityKind.RenderPreparing,
        pendingCount: 2,
        preparedCount: 6,
        progress: 0.75,
        status: MediaSessionActivityStatus.Running,
      }),
    ]);
  });
});

function createRendererState(options: {
  readonly detectionBufferStatus: DetectionBufferStatus;
  readonly playbackState: MediaRendererPlaybackState;
}): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    currentTime: 0,
    detectionBuffer: {
      bufferEndTime: null,
      bufferStartTime: null,
      detectionCount: 0,
      errorMessage: null,
      frameCount: 0,
      requestedEndTime: null,
      requestedStartTime: null,
      status: options.detectionBufferStatus,
    },
    duration: null,
    fit: MediaRendererFit.Contain,
    mediaHeight: 0,
    mediaWidth: 0,
    playbackState: options.playbackState,
    presentedFrames: 0,
    source: {
      audioTrackCount: null,
      canRead: null,
      duration: null,
      errorMessage: null,
      formatMimeType: null,
      formatName: null,
      mimeType: null,
      primaryVideoHeight: null,
      primaryVideoWidth: null,
      status: MediaSourceStatus.Loading,
      trackCount: null,
      videoTrackCount: null,
    },
  };
}
