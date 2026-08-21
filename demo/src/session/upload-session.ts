import {
  DetectionFrameSelectionMode,
  MediaInteractionMode,
  MediaRendererFit,
  MediaRendererPlaybackState,
  RenderPreparationMode,
  createBrowserColdDetectionFrameStore,
  createMediaSession,
  createVideoEngineMediaRendererSource,
  type ColdDetectionFrameStoreWriteSummary,
  type DetectionFrame,
  type MediaSession,
  type MediaRenderer,
  type WritableDetectionFrameSource,
} from "supervision";
import { SourceKind } from "@roboflow/video-engine";
import type {
  DemoFixtureDetectionSourceSummary,
  DemoFixtureSummary,
} from "../fixtures/demo-fixtures";
import { inferSam3FrameBatchStream } from "../inference/roboflow-sam3";
import {
  TARGET_UPLOAD_FRAME_RATE,
  createPreparedUploadedVideoMedia,
  extractInferenceFrameBatches,
  prepareUploadedImageMedia,
  type PreparedUploadMedia,
} from "../media/upload-media";
import { createDemoPresentation } from "../presentation/demo-presentation";
import { readDemoDisplayBox } from "./decode-resolution";
import { UPLOAD_DETECTION_CHUNK_SECONDS } from "./demo-session-config";
import { getDemoMaxDevicePixelRatio } from "./render-quality";
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

  const presentation = createDemoPresentation(options.presentationSettings);
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
        appendable: {
          chunkDurationSeconds: UPLOAD_DETECTION_CHUNK_SECONDS,
          clearOnCreate: true,
          datasetId,
          store,
        },
        sync: {
          frameIndexOriginTime: 0,
          frameRate: TARGET_UPLOAD_FRAME_RATE,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: options.tapMediaSource(
        createVideoEngineMediaRendererSource({
          display: readDemoDisplayBox(options.container, options.renderQuality),
          source: {
            blob: preparedMedia?.blob ?? options.uploadRun.file,
            kind: SourceKind.Blob,
          },
        }),
      ),
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
        maxDevicePixelRatio: getDemoMaxDevicePixelRatio(options.renderQuality),
        onFrame: options.onFrame,
        onState: options.onRendererState,
        renderPreparation: {
          mode: RenderPreparationMode.Worker,
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
      renderer: session.renderer,
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

  const detectionSource = getAppendableSessionDetectionSource(session);

  options.onMediaState({
    errorMessage: null,
    status: preparedMedia.statusLabel,
  });
  options.onFixtureSummary(
    createUploadSummary(preparedMedia, {
      classNames: options.uploadRun.classNames,
      detectionCount: 0,
    }),
  );
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

function getAppendableSessionDetectionSource(
  session: MediaSession,
): WritableDetectionFrameSource {
  const detectionSource = session.detectionSource;

  if (
    !detectionSource ||
    !("appendFrames" in detectionSource) ||
    !("getSummary" in detectionSource) ||
    !("datasetId" in detectionSource)
  ) {
    throw new Error(
      "Upload media session did not create an appendable detection source.",
    );
  }

  return detectionSource as WritableDetectionFrameSource;
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
          createUploadSummary(options.preparedMedia, {
            classNames: options.uploadRun.classNames,
            detectionCount: summary.detectionCount,
          }),
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
  options: {
    readonly classNames: readonly string[];
    readonly detectionCount: number;
  },
): DemoFixtureSummary {
  return {
    classNames: options.classNames,
    detectionCount: options.detectionCount,
    duration: media.duration,
    fixtureName: `Uploaded ${media.kind}`,
    frameCount: media.frameCount,
    geometry: null,
    inferenceFrameRate: media.frameRate,
    inferenceLabel: "SAM3",
    maskHeight: media.height,
    maskWidth: media.width,
    missingFrameIndexes: [],
  };
}

function getDetectionSourceSummary(
  source: WritableDetectionFrameSource,
): DemoFixtureDetectionSourceSummary | null {
  const summary = source.getSummary();

  return summary ? convertWriteSummary(summary) : null;
}

function convertWriteSummary(
  summary: ColdDetectionFrameStoreWriteSummary,
): DemoFixtureDetectionSourceSummary {
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
