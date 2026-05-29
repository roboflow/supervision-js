import {
  DetectionFrameSelectionMode,
  MediaRendererFit,
  MediaRendererPlaybackState,
  createBrowserColdDetectionFrameStore,
  createMediaRenderer,
  createWritableDetectionFrameSource,
  type ColdDetectionFrameStoreWriteSummary,
  type DetectionFrame,
  type MediaRenderer,
  type WritableDetectionFrameSource,
} from "supervision-js";
import type {
  BasketballSampleDetectionSourceSummary,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import { inferSam3FrameBatchStream } from "../inference/roboflow-sam3";
import {
  extractInferenceFrameBatches,
  prepareUploadedMedia,
  type PreparedUploadMedia,
} from "../media/upload-media";
import { createBasketballSamplePresentation } from "../presentation/basketball-presentation";
import {
  UPLOAD_DETECTION_BUFFER_AHEAD_SECONDS,
  UPLOAD_DETECTION_BUFFER_BEHIND_SECONDS,
  UPLOAD_DETECTION_CHUNK_SECONDS,
} from "./demo-session-config";
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
): Promise<{
  readonly detectionSource: WritableDetectionFrameSource;
  readonly mediaObjectUrl: string;
  readonly renderer: MediaRenderer;
}> {
  const datasetId = `upload_${Date.now()}`;
  const store = createBrowserColdDetectionFrameStore({
    databaseName: "supervision-js-demo-upload-detections",
  });
  const detectionSource = createWritableDetectionFrameSource({
    chunkDurationSeconds: UPLOAD_DETECTION_CHUNK_SECONDS,
    datasetId,
    store,
  });

  await detectionSource.clear();
  options.onDetectionSourceState({
    datasetId,
    errorMessage: null,
    sourceSummary: null,
    status: "ready | waiting for SAM3 frames",
  });

  const preparedMedia = await prepareUploadedMedia({
    file: options.uploadRun.file,
    onProgress(progress) {
      options.onUploadState((current) => ({
        ...current,
        status: "preparing",
        statusLabel: `normalizing media ${Math.round(progress.progress * 100)}%`,
      }));
    },
    signal: options.abortSignal,
  });

  if (!options.isActive()) {
    URL.revokeObjectURL(preparedMedia.objectUrl);
    detectionSource.destroy?.();
    throw new Error("Upload session was canceled.");
  }

  options.onMediaState({
    errorMessage: null,
    status: preparedMedia.statusLabel,
  });
  options.onFixtureSummary(createUploadSummary(preparedMedia, 0));
  options.onUploadState({
    completedFrames: 0,
    errorMessage: null,
    inferredDetections: 0,
    preparedMedia,
    processedRanges: [],
    processingRanges: [],
    status: "running",
    statusLabel: "running SAM3",
    totalFrames: preparedMedia.frameCount,
  });

  const presentation = createBasketballSamplePresentation(
    options.presentationSettings,
  );
  let renderer: MediaRenderer;

  try {
    renderer = await createMediaRenderer({
      autoPlay: false,
      boxStyle: presentation.boxStyle ?? undefined,
      container: options.container,
      detectionBuffer: {
        bufferAheadSeconds: UPLOAD_DETECTION_BUFFER_AHEAD_SECONDS,
        bufferBehindSeconds: UPLOAD_DETECTION_BUFFER_BEHIND_SECONDS,
        frameIndexOriginTime: 0,
        frameRate: preparedMedia.frameRate,
        selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
      },
      detectionSource,
      fit: MediaRendererFit.Contain,
      loop: true,
      maskStyle: presentation.maskStyle ?? undefined,
      onFrame: options.onFrame,
      onSource: options.onSourceState,
      src: preparedMedia.objectUrl,
    });
  } catch (error) {
    URL.revokeObjectURL(preparedMedia.objectUrl);
    detectionSource.destroy?.();
    throw error;
  }

  void runUploadInference({
    abortSignal: options.abortSignal,
    detectionSource,
    isActive: options.isActive,
    onDetectionSourceState: options.onDetectionSourceState,
    onFixtureSummary: options.onFixtureSummary,
    onUploadState: options.onUploadState,
    preparedMedia,
    renderer,
    uploadRun: options.uploadRun,
  });

  return {
    detectionSource,
    mediaObjectUrl: preparedMedia.objectUrl,
    renderer,
  };
}

async function runUploadInference(options: {
  readonly abortSignal: AbortSignal;
  readonly detectionSource: WritableDetectionFrameSource;
  readonly isActive: () => boolean;
  readonly onDetectionSourceState: DemoSessionCallbacks["onDetectionSourceState"];
  readonly onFixtureSummary: DemoSessionCallbacks["onFixtureSummary"];
  readonly onUploadState: UploadInferenceStateSetter;
  readonly preparedMedia: PreparedUploadMedia;
  readonly renderer: MediaRenderer;
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
        const summary = await options.detectionSource.appendFrames([
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
        refreshPausedRendererForFrame(options.renderer, detectionFrame);
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
      const summary = options.detectionSource.getSummary();

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

  if (state.playbackState === MediaRendererPlaybackState.Playing) {
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
