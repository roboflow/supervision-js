import { describe, expect, it } from "vitest";

import { DetectionBufferStatus, MediaErrorKind } from "supervision-js-core";
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
  RenderPreparationGateHoldReason,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";
import {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMediaBranch,
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

  /**
   * A local file already in memory, held while inference runs, reported both as
   * a stopped picture and as a wait for the model. A host reading the vaguer of
   * the two first tells the viewer the video is still downloading.
   */
  it("separates waiting for a detection producer from loading detections", () => {
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
        detectionBufferStatus: DetectionBufferStatus.AwaitingCoverage,
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    });

    expect(state.playbackBlocked).toBe(true);
    expect(state.activities).toEqual([
      expect.objectContaining({
        blockingPlayback: true,
        blockingPresentation: false,
        kind: MediaSessionActivityKind.DetectionsAwaitingCoverage,
        label: "Waiting for the model",
        status: MediaSessionActivityStatus.Waiting,
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

  it("carries the source's failure kind on the renderer error activity", () => {
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
        sourceErrorKind: MediaErrorKind.UnsupportedFormat,
        sourceErrorMessage:
          "openInput: browser cannot decode this video track's codec hevc",
        sourceStatus: MediaSourceStatus.Error,
      }),
    });

    expect(state.activities).toEqual([
      expect.objectContaining({
        errorKind: MediaErrorKind.UnsupportedFormat,
        kind: MediaSessionActivityKind.Error,
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
  /**
   * A local file already in memory, held at the start of playback while its
   * masks rasterize. Reported as a stopped picture alone, it reads as a slow
   * network on a file that is not being fetched at all.
   */
  it("names the masks when they are what stopped the picture", () => {
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
              key: "1.500",
              mediaTime: 1.5,
              status: RenderPreparationArtifactFrameStatus.Pending,
            },
            kind: RenderPreparationArtifactKind.MaskFrame,
            pendingCount: 3,
            preparedCount: 9,
          },
        ],
        executionMode: RenderPreparationExecutionMode.Worker,
        message: null,
        workerStatus: RenderPreparationWorkerStatus.Ready,
      },
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    });

    expect(
      state.activities.map((entry) => ({
        blockingPlayback: entry.blockingPlayback,
        kind: entry.kind,
        label: entry.label,
      })),
    ).toStrictEqual([
      {
        blockingPlayback: true,
        kind: MediaSessionActivityKind.RenderPreparing,
        label: "Waiting for the masks",
      },
    ]);
  });

  /**
   * Shot 1: 84 of 84 frames prepared, the frame on screen among them, and the
   * gate still holding to bank a lead. Nothing is pending and the active frame
   * is ready, so every earlier signal reads clear and the wait was described as
   * a download on a file sitting on the viewer's own disk.
   */
  it("names a lead being banked rather than blaming the transfer", () => {
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
              key: "0.167",
              mediaTime: 0.1668,
              status: RenderPreparationArtifactFrameStatus.Prepared,
            },
            gateHold: {
              reason: RenderPreparationGateHoldReason.LeadBelowRequirement,
              requiredAheadSeconds: 1,
            },
            kind: RenderPreparationArtifactKind.MaskFrame,
            pendingCount: 0,
            preparedAheadSeconds: 0.25,
            preparedCount: 84,
          },
        ],
        executionMode: RenderPreparationExecutionMode.Worker,
        message: null,
        workerStatus: RenderPreparationWorkerStatus.Ready,
      },
      renderer: createRendererState({
        detectionBufferStatus: DetectionBufferStatus.Ready,
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
    });

    expect(state.activities).toStrictEqual([
      {
        artifactKind: RenderPreparationArtifactKind.MaskFrame,
        blockingPlayback: true,
        blockingPresentation: false,
        detail:
          "This frame is ready; the video starts once enough is drawn ahead of it",
        kind: MediaSessionActivityKind.RenderPreparing,
        label: "Drawing ahead of the video",
        pendingCount: 0,
        preparedCount: 84,
        progress: 0.25,
        status: MediaSessionActivityStatus.Waiting,
      },
    ]);
  });

  it("blames a transfer only where the session opened one", () => {
    const stoppedOn = (branch: MediaSessionMediaBranch | undefined) =>
      createMediaSessionStateSnapshot({
        errorMessage: null,
        media: {
          inputMetadata: null,
          normalizedMedia: null,
          objectUrl: null,
          preparation: branch ? { branch, opened: "src" } : null,
        },
        normalization: null,
        renderPreparation: null,
        renderer: createRendererState({
          detectionBufferStatus: DetectionBufferStatus.Ready,
          playbackState: MediaRendererPlaybackState.Buffering,
        }),
      }).activities[0].detail;

    expect({
      blob: stoppedOn(MediaSessionMediaBranch.BlobObjectUrl),
      normalized: stoppedOn(MediaSessionMediaBranch.NormalizedObjectUrl),
      progressive: stoppedOn(MediaSessionMediaBranch.ProgressiveSource),
      rendererSource: stoppedOn(MediaSessionMediaBranch.RendererSource),
      unknown: stoppedOn(undefined),
      url: stoppedOn(MediaSessionMediaBranch.Url),
    }).toStrictEqual({
      blob: "This part of the video is still being read",
      normalized: "This part of the video is still being read",
      progressive: "This part of the video is still being read",
      rendererSource: "This part of the video is still being read",
      unknown: "This part of the video is still being read",
      url: "This part of the video has not downloaded yet",
    });
  });

  it("names detections still arriving apart from video still arriving", () => {
    const stoppedFor = (detectionBufferStatus: DetectionBufferStatus) =>
      createMediaSessionStateSnapshot({
        errorMessage: null,
        media: {
          inputMetadata: null,
          normalizedMedia: null,
          objectUrl: null,
        },
        normalization: null,
        renderPreparation: null,
        renderer: createRendererState({
          detectionBufferStatus,
          playbackState: MediaRendererPlaybackState.Buffering,
        }),
      }).activities.map((activity) => activity.label);

    expect({
      detections: stoppedFor(DetectionBufferStatus.Loading),
      media: stoppedFor(DetectionBufferStatus.Ready),
      model: stoppedFor(DetectionBufferStatus.AwaitingCoverage),
    }).toStrictEqual({
      detections: ["Waiting for detections"],
      media: ["Waiting for more video"],
      model: ["Waiting for the model"],
    });
  });
});

function createRendererState(options: {
  readonly detectionBufferStatus: DetectionBufferStatus;
  readonly playbackState: MediaRendererPlaybackState;
  readonly sourceErrorKind?: MediaErrorKind | null;
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
    drawnMaskFrameTime: null,
    duration: null,
    fit: MediaRendererFit.Contain,
    lastFrameRenderTimings: null,
    maskHeldStale: false,
    mediaHeight: 0,
    mediaWidth: 0,
    playbackState: options.playbackState,
    presentedFrames: 0,
    rendererBackend: "test",
    source: {
      audioTrackCount: null,
      canRead: null,
      duration: null,
      errorKind: options.sourceErrorKind ?? null,
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
