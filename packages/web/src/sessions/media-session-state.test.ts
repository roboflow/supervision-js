import { describe, expect, it } from "vitest";

import { DetectionBufferStatus } from "supervision-js-core";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererState,
} from "#types/media-renderer";
import {
  RenderPreparationArtifactFrameStatus,
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
          blockingPlayback: true,
          blockingPresentation: true,
          kind: MediaSessionActivityKind.MediaOpening,
          status: MediaSessionActivityStatus.Running,
        },
      ],
      playbackBlocked: true,
      presentationBlocked: true,
      status: MediaSessionStatus.Loading,
    });
  });

  it("reports background normalization without blocking playback or presentation", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: {
        active: true,
        progress: {
          processedTime: 3,
          progress: 0.4,
        },
      },
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Playing,
      }),
    });

    expect(state.status).toBe(MediaSessionStatus.Processing);
    expect(state.playbackBlocked).toBe(false);
    expect(state.presentationBlocked).toBe(false);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: false,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.MediaNormalizing,
        progress: 0.4,
        status: MediaSessionActivityStatus.Running,
      }),
    ]);
  });

  it("reports background detection loading without blocking playback", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Loading,
        playbackState: MediaRendererPlaybackState.Playing,
      }),
    });

    expect(state.status).toBe(MediaSessionStatus.Playing);
    expect(state.playbackBlocked).toBe(false);
    expect(state.presentationBlocked).toBe(false);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: false,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.DetectionsLoading,
        status: MediaSessionActivityStatus.Running,
      }),
    ]);
  });

  it("marks playback buffering as playback-blocking", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    });

    expect(state.status).toBe(MediaSessionStatus.Buffering);
    expect(state.playbackBlocked).toBe(true);
    expect(state.presentationBlocked).toBe(false);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.PlaybackBuffering,
        status: MediaSessionActivityStatus.Waiting,
      }),
    ]);
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
    expect(state.playbackBlocked).toBe(true);
    expect(state.presentationBlocked).toBe(false);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.PlaybackBuffering,
        status: MediaSessionActivityStatus.Waiting,
      }),
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.DetectionsBuffering,
        status: MediaSessionActivityStatus.Waiting,
      }),
      expect.objectContaining({
        artifactKind: RenderPreparationArtifactKind.MaskFrame,
        blockingPlayback: false,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.RenderPreparing,
        pendingCount: 2,
        preparedCount: 6,
        progress: 0.75,
        status: MediaSessionActivityStatus.Running,
      }),
    ]);
  });

  it("marks active-frame render preparation as presentation-blocking", () => {
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
            activeFrame: {
              key: "12:0.4",
              mediaTime: 0.4,
              status: RenderPreparationArtifactFrameStatus.Pending,
            },
            kind: RenderPreparationArtifactKind.MaskFrame,
            pendingCount: 5,
            preparedCount: 10,
          },
        ],
        executionMode: RenderPreparationExecutionMode.Worker,
        message: null,
        workerStatus: RenderPreparationWorkerStatus.Ready,
      },
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Playing,
      }),
    });

    expect(state.playbackBlocked).toBe(false);
    expect(state.presentationBlocked).toBe(true);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: false,
        blockingPresentation: true,
        detail: "Active frame 0.400s is waiting for maskFrame",
        kind: MediaSessionActivityKind.RenderPreparing,
        status: MediaSessionActivityStatus.Waiting,
      }),
    ]);
  });

  it("keeps background-only render preparation non-blocking", () => {
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
            activeFrame: {
              key: "12:0.4",
              mediaTime: 0.4,
              status: RenderPreparationArtifactFrameStatus.Prepared,
            },
            kind: RenderPreparationArtifactKind.MaskFrame,
            pendingCount: 5,
            preparedCount: 10,
          },
        ],
        executionMode: RenderPreparationExecutionMode.Worker,
        message: null,
        workerStatus: RenderPreparationWorkerStatus.Ready,
      },
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Playing,
      }),
    });

    expect(state.playbackBlocked).toBe(false);
    expect(state.presentationBlocked).toBe(false);
    expect(state.activities).toEqual([
      expect.objectContaining({
        artifactKind: RenderPreparationArtifactKind.MaskFrame,
        blockingPlayback: false,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.RenderPreparing,
        status: MediaSessionActivityStatus.Running,
      }),
    ]);
  });

  it("reports renderer errors as blocking errors", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Error,
        sourceErrorMessage: "Decoder failed",
        sourceStatus: MediaSourceStatus.Error,
      }),
    });

    expect(state).toMatchObject({
      errorMessage: "Decoder failed",
      playbackBlocked: true,
      presentationBlocked: true,
      status: MediaSessionStatus.Error,
    });
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage: "Decoder failed",
        kind: MediaSessionActivityKind.Error,
        status: MediaSessionActivityStatus.Error,
      }),
    ]);
  });

  it("reports session errors as blocking errors", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: "Session setup failed",
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Ready,
      }),
    });

    expect(state).toMatchObject({
      errorMessage: "Session setup failed",
      playbackBlocked: true,
      presentationBlocked: true,
      status: MediaSessionStatus.Error,
    });
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage: "Session setup failed",
        kind: MediaSessionActivityKind.Error,
        status: MediaSessionActivityStatus.Error,
      }),
    ]);
  });

  it("reports destroyed sessions without synthetic loading work", () => {
    const state = createMediaSessionStateSnapshot({
      errorMessage: null,
      media: {
        inputMetadata: null,
        normalizedMedia: null,
        objectUrl: null,
      },
      normalization: null,
      renderPreparation: null,
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Destroyed,
        playbackState: MediaRendererPlaybackState.Destroyed,
        sourceStatus: MediaSourceStatus.Destroyed,
      }),
    });

    expect(state).toMatchObject({
      activities: [],
      playbackBlocked: false,
      presentationBlocked: false,
      status: MediaSessionStatus.Destroyed,
    });
  });
});

function createRendererState(options: {
  readonly detectionBufferStatus: DetectionBufferStatus;
  readonly playbackState: MediaRendererPlaybackState;
  readonly sourceErrorMessage?: string | null;
  readonly sourceStatus?: MediaSourceStatus;
}): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    currentTime: 0,
    playbackRate: 1,
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
    lastFrameRenderTimings: null,
    mediaHeight: 0,
    mediaWidth: 0,
    playbackState: options.playbackState,
    presentedFrames: 0,
    rendererBackend: "test",
    source: {
      audioTrackCount: null,
      canRead: null,
      duration: null,
      errorKind: null,
      errorMessage: options.sourceErrorMessage ?? null,
      estimatedFrameCount: null,
      estimatedFrameRate: null,
      firstTimestamp: null,
      formatMimeType: null,
      formatName: null,
      mimeType: null,
      primaryVideoHeight: null,
      primaryVideoWidth: null,
      status: options.sourceStatus ?? MediaSourceStatus.Loading,
      trackCount: null,
      videoTrackCount: null,
    },
  };
}
