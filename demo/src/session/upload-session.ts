import {
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaInteractionMode,
  MediaRendererFit,
  MediaSessionMode,
  MediaRendererPlaybackState,
  createBrowserColdDetectionFrameStore,
  createMediaSession,
  type ColdDetectionFrameStoreWriteSummary,
  type DetectionFrame,
  type MediaSession,
  type MediaNormalizationProgress,
  type MediaRenderer,
  type WritableDetectionFrameSource,
} from "supervision-js";
import type {
  BasketballSampleDetectionSourceSummary,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import { inferSam3FrameBatchStream } from "../inference/roboflow-sam3";
import {
  NORMALIZED_UPLOAD_VIDEO_BITRATE,
  TARGET_UPLOAD_FRAME_RATE,
  createPreparedUploadedVideoMedia,
  extractInferenceFrameBatches,
  prepareUploadedImageMedia,
  UploadedMediaKind,
  type PreparedUploadMedia,
} from "../media/upload-media";
import { createBasketballSamplePresentation } from "../presentation/basketball-presentation";
import { UPLOAD_DETECTION_CHUNK_SECONDS } from "./demo-session-config";
import type {
  DemoSessionCallbacks,
  UploadInferenceStateSetter,
} from "./demo-session-types";
import {
  addTimelineRange,
  appendTimelineRange,
  createBatchTimelineRange,
  createDetectionFrameTimelineRange,
  removeTimelineRange,
} from "./timeline-ranges";

export interface UploadRunRequest {
  readonly apiKey: string;
  readonly classNames: readonly string[];
  readonly file: File;
}

export async function createUploadSession(
  options: {
    readonly abortSignal: AbortSignal;
    readonly container: HTMLDivElement;
    readonly onUploadState: UploadInferenceStateSetter;
    readonly uploadRun: UploadRunRequest;
  } & DemoSessionCallbacks,
): Promise<MediaSession> {
  const datasetId = `upload_${Date.now()}`;
  const store = createBrowserColdDetectionFrameStore({
    databaseName: "supervision-js-demo-upload-detections",
  });

  options.onDetectionSourceState({
    datasetId,
    errorMessage: null,
    sourceSummary: null,
    status: "ready | waiting for SAM3 frames",
  });

  const presentation = createBasketballSamplePresentation(
    options.presentationSettings,
  );
  const isImageUpload = options.uploadRun.file.type.startsWith("image/");
  let preparedMedia: PreparedUploadMedia | undefined;
  let session: MediaSession | undefined;

  try {
    if (isImageUpload) {
      preparedMedia = await prepareUploadedImageMedia({
        file: options.uploadRun.file,
        signal: options.abortSignal,
      });
    }

    if (!options.isActive()) {
      throw new Error("Upload session was canceled.");
    }

    session = await createMediaSession({
      container: options.container,
      detections: {
        buffer: {
          frameIndexOriginTime: 0,
          frameRate: TARGET_UPLOAD_FRAME_RATE,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        writable: {
          chunkDurationSeconds: UPLOAD_DETECTION_CHUNK_SECONDS,
          clearOnCreate: true,
          datasetId,
          retention: { mode: DetectionFrameRetentionMode.PersistAll },
          store,
        },
      },
      media: preparedMedia?.blob ?? options.uploadRun.file,
      mode: MediaSessionMode.File,
      normalize: isImageUpload
        ? false
        : {
            audio: { discard: true },
            container: MediaNormalizationContainer.WebM,
            onProgress(progress) {
              options.onUploadState((current) => ({
                ...current,
                normalizedRanges: createNormalizationTimelineRanges(progress),
                status: "preparing",
                statusLabel: `stream-normalizing media ${Math.round(
                  progress.progress * 100,
                )}%`,
              }));
            },
            signal: options.abortSignal,
            stream: true,
            video: {
              bitrate: NORMALIZED_UPLOAD_VIDEO_BITRATE,
              codec: MediaNormalizationVideoCodec.Vp9,
              forceTranscode: true,
              frameRate: TARGET_UPLOAD_FRAME_RATE,
              keyFrameInterval: 1,
            },
          },
      presentation,
      onState: options.onSessionState,
      renderer: {
        autoPlay: false,
        fit: MediaRendererFit.Contain,
        interaction: {
          mode: MediaInteractionMode.PausedOnly,
          onHover: options.onDetectionHover,
          onSelect: options.onDetectionSelect,
        },
        loop: true,
        onFrame: options.onFrame,
        onState: options.onRendererState,
        renderPreparation: {
          onDiagnostics: options.onRenderPreparationDiagnostics,
        },
        onSource: options.onSourceState,
      },
    });
  } catch (error) {
    session?.destroy();
    store.destroy?.();
    throw error;
  }

  if (!isImageUpload) {
    preparedMedia = createPreparedUploadedVideoMedia({
      file: options.uploadRun.file,
      media: session.media,
    });
  }

  if (!preparedMedia) {
    session.destroy();
    throw new Error("Upload media could not be prepared.");
  }

  if (!options.isActive()) {
    session.destroy();
    throw new Error("Upload session was canceled.");
  }

  const detectionSource = getWritableSessionDetectionSource(session);

  options.onMediaState({
    errorMessage: null,
    status: preparedMedia.statusLabel,
  });
  options.onFixtureSummary(createUploadSummary(preparedMedia, 0));
  options.onUploadState({
    completedFrames: 0,
    errorMessage: null,
    inferredDetections: 0,
    normalizedRanges:
      preparedMedia.kind === UploadedMediaKind.Image
        ? [{ endTime: preparedMedia.duration, startTime: 0 }]
        : [],
    preparedMedia,
    processedRanges: [],
    processingRanges: [],
    status: "running",
    statusLabel: "running SAM3",
    totalFrames: preparedMedia.frameCount,
  });
  watchNormalizationCompletion({
    isActive: options.isActive,
    onMediaState: options.onMediaState,
    onUploadState: options.onUploadState,
    preparedMedia,
  });

  void runUploadInference({
    abortSignal: options.abortSignal,
    detectionSource,
    isActive: options.isActive,
    onDetectionSourceState: options.onDetectionSourceState,
    onFixtureSummary: options.onFixtureSummary,
    onUploadState: options.onUploadState,
    preparedMedia,
    session,
    uploadRun: options.uploadRun,
  });

  return session;
}

function getWritableSessionDetectionSource(
  session: MediaSession,
): WritableDetectionFrameSource {
  const detectionSource = session.detectionSource;

  if (
    !detectionSource ||
    !("appendFrames" in detectionSource) ||
    !("getSummary" in detectionSource) ||
    !("datasetId" in detectionSource)
  ) {
    throw new Error("Upload media session did not create writable detections.");
  }

  return detectionSource as WritableDetectionFrameSource;
}

function watchNormalizationCompletion(options: {
  readonly isActive: () => boolean;
  readonly onMediaState: DemoSessionCallbacks["onMediaState"];
  readonly onUploadState: UploadInferenceStateSetter;
  readonly preparedMedia: PreparedUploadMedia;
}) {
  if (!options.preparedMedia.normalizationCompletion) {
    return;
  }

  void options.preparedMedia.normalizationCompletion
    .then(() => {
      if (!options.isActive()) {
        return;
      }

      options.onMediaState({
        errorMessage: null,
        status: `upload normalized WebM ${options.preparedMedia.frameRate}fps complete`,
      });
      options.onUploadState((current) => ({
        ...current,
        normalizedRanges: [
          { endTime: options.preparedMedia.duration, startTime: 0 },
        ],
      }));
    })
    .catch((error: unknown) => {
      if (!options.isActive()) {
        return;
      }

      const message = getErrorMessage(error, "Media normalization failed.");

      options.onMediaState({ errorMessage: message, status: "error" });
      options.onUploadState((current) => ({
        ...current,
        errorMessage: message,
        status: "error",
        statusLabel: message,
      }));
    });
}

async function runUploadInference(options: {
  readonly abortSignal: AbortSignal;
  readonly detectionSource: WritableDetectionFrameSource;
  readonly isActive: () => boolean;
  readonly onDetectionSourceState: DemoSessionCallbacks["onDetectionSourceState"];
  readonly onFixtureSummary: DemoSessionCallbacks["onFixtureSummary"];
  readonly onUploadState: UploadInferenceStateSetter;
  readonly preparedMedia: PreparedUploadMedia;
  readonly session: MediaSession;
  readonly uploadRun: Pick<UploadRunRequest, "apiKey" | "classNames">;
}) {
  try {
    for await (const batch of extractInferenceFrameBatches({
      media: options.preparedMedia,
      signal: options.abortSignal,
    })) {
      if (!options.isActive()) {
        return;
      }

      const batchRange = createBatchTimelineRange(
        batch,
        options.preparedMedia.duration,
      );

      options.onUploadState((current) => ({
        ...current,
        processingRanges: appendTimelineRange(
          current.processingRanges,
          batchRange,
        ),
        status: "running",
        statusLabel: "SAM3 requests in flight",
      }));

      for await (const detectionFrame of inferSam3FrameBatchStream({
        apiKey: options.uploadRun.apiKey,
        frames: batch,
        prompts: options.uploadRun.classNames,
        signal: options.abortSignal,
      })) {
        const summary = await options.session.appendDetectionFrames([
          detectionFrame,
        ]);

        if (!options.isActive()) {
          return;
        }

        options.onFixtureSummary(
          createUploadSummary(options.preparedMedia, summary.detectionCount),
        );
        options.onDetectionSourceState({
          datasetId: options.detectionSource.datasetId,
          errorMessage: null,
          sourceSummary: convertWriteSummary(summary),
          status: "ready | SAM3 streaming",
        });
        options.onUploadState((current) => ({
          ...current,
          completedFrames: Math.min(
            options.preparedMedia.frameCount,
            current.completedFrames + 1,
          ),
          inferredDetections: summary.detectionCount,
          preparedMedia: options.preparedMedia,
          processedRanges: addTimelineRange(
            current.processedRanges,
            createDetectionFrameTimelineRange(detectionFrame),
          ),
          status: "running",
          statusLabel: "SAM3 frames streaming into cold storage",
          totalFrames: options.preparedMedia.frameCount,
        }));
        refreshPausedRendererForFrame(options.session.renderer, detectionFrame);
      }

      options.onUploadState((current) => ({
        ...current,
        processingRanges: removeTimelineRange(
          current.processingRanges,
          batchRange,
        ),
        status: "running",
        statusLabel: "SAM3 batch complete",
      }));
    }

    if (options.isActive()) {
      const summary = options.session.getDetectionSummary();

      options.onUploadState((current) => ({
        ...current,
        completedFrames: options.preparedMedia.frameCount,
        inferredDetections:
          summary?.detectionCount ?? current.inferredDetections,
        processingRanges: [],
        status: "ready",
        statusLabel: "SAM3 inference complete",
        totalFrames: options.preparedMedia.frameCount,
      }));
    }
  } catch (error: unknown) {
    handleUploadInferenceError(error, options);
  }
}

function handleUploadInferenceError(
  error: unknown,
  options: {
    readonly abortSignal: AbortSignal;
    readonly detectionSource: WritableDetectionFrameSource;
    readonly isActive: () => boolean;
    readonly onDetectionSourceState: DemoSessionCallbacks["onDetectionSourceState"];
    readonly onUploadState: UploadInferenceStateSetter;
  },
) {
  if (!options.isActive()) {
    return;
  }

  if (options.abortSignal.aborted) {
    options.onUploadState((current) => ({
      ...current,
      processingRanges: [],
      status: "idle",
      statusLabel: "upload inference canceled",
    }));
    options.onDetectionSourceState({
      datasetId: options.detectionSource.datasetId,
      errorMessage: null,
      sourceSummary: getDetectionSourceSummary(options.detectionSource),
      status: "ready | SAM3 canceled",
    });
    return;
  }

  const message = getErrorMessage(error, "SAM3 inference failed.");

  options.onUploadState((current) => ({
    ...current,
    errorMessage: message,
    processingRanges: [],
    status: "error",
    statusLabel: message,
  }));
  options.onDetectionSourceState({
    datasetId: options.detectionSource.datasetId,
    errorMessage: message,
    sourceSummary: getDetectionSourceSummary(options.detectionSource),
    status: "error",
  });
}

function refreshPausedRendererForFrame(
  renderer: MediaRenderer,
  frame: DetectionFrame,
) {
  const state = renderer.getState();

  if (
    state.playbackState === MediaRendererPlaybackState.Playing ||
    state.playbackState === MediaRendererPlaybackState.Buffering
  ) {
    return;
  }

  if (!frameOverlapsTime(frame, state.currentTime)) {
    return;
  }

  void renderer.seek(state.currentTime).catch(() => undefined);
}

function frameOverlapsTime(frame: DetectionFrame, time: number) {
  const frameEndTime = frame.endTime ?? frame.mediaTime;

  return frame.mediaTime <= time && time <= frameEndTime;
}

function createUploadSummary(
  media: PreparedUploadMedia,
  detectionCount: number,
): BasketballSampleSummary {
  return {
    detectionCount,
    duration: media.duration,
    fixtureName: `Uploaded ${media.kind}`,
    frameCount: media.frameCount,
    inferenceFrameRate: media.frameRate,
    inferenceLabel: "SAM3",
    maskHeight: media.height,
    maskWidth: media.width,
    missingFrameIndexes: [],
  };
}

function createNormalizationTimelineRanges(
  progress: MediaNormalizationProgress,
) {
  if (progress.processedTime <= 0) {
    return [];
  }

  return [{ endTime: progress.processedTime, startTime: 0 }];
}

function getDetectionSourceSummary(
  source: WritableDetectionFrameSource,
): BasketballSampleDetectionSourceSummary | null {
  const summary = source.getSummary();

  return summary ? convertWriteSummary(summary) : null;
}

function convertWriteSummary(
  summary: ColdDetectionFrameStoreWriteSummary,
): BasketballSampleDetectionSourceSummary {
  return {
    chunkCount: summary.chunkCount,
    chunkDurationSeconds: summary.chunkDurationSeconds,
    datasetId: summary.datasetId,
    detectionCount: summary.detectionCount,
    endTime: summary.endTime,
    frameCount: summary.frameCount,
    startTime: summary.startTime,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
