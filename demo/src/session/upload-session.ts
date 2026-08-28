import {
  DetectionFrameSelectionMode,
  MediaSessionMode,
  createBrowserColdDetectionFrameStore,
  createMediaSession,
  createVideoEngineMediaRendererSource,
  type ColdDetectionFrameStoreWriteSummary,
  type DecodedVideoSampleSink,
  type MediaSession,
  type MediaSessionDetectionOptions,
  type MediaRendererSource,
  type WritableDetectionFrameSource,
} from "supervision";
import { SourceKind } from "supervision-js-video-engine";
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
import { createDemoRendererOptions } from "./demo-session-renderer";
import { UPLOAD_DETECTION_CHUNK_SECONDS } from "./demo-session-config";
import type {
  DemoSessionCallbacks,
  UploadInferenceStateSetter,
} from "./demo-session-types";
import {
  applyDemoDetectionOptions,
  applyDemoEngineOptions,
  applyDemoRendererOptions,
  applyDemoSessionMode,
  applyDemoSessionPlaybackGate,
  DemoEngineSource,
  DemoMediaPath,
  describeMissingSupport,
  resolveDemoSessionConfiguration,
} from "./session-options";
import {
  addTimelineRange,
  appendTimelineRange,
  createBatchTimelineRange,
  createDetectionFrameTimelineRange,
  removeTimelineRange,
} from "./timeline-ranges";

/**
 * SAM3 reads its frames back out of the opened video-engine source, so this
 * session cannot hand the clip to `createMediaSession` as a `Blob`, which is
 * the only shape `normalize` acts on.
 */
const UPLOAD_MEDIA_PATH_BLOCKED = describeMissingSupport(
  "SAM3 inference reads frames back from the video engine as it runs, so an upload always opens on the video engine.",
);
const UPLOAD_NORMALIZATION_BLOCKED = describeMissingSupport(
  "SAM3 inference reads frames back from the video engine source, which normalizing would replace.",
);

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
  const baseDetections: MediaSessionDetectionOptions = {
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
  };
  const detections = applyDemoDetectionOptions(
    baseDetections,
    options.sessionOptions,
  );
  const renderer = applyDemoRendererOptions(
    createDemoRendererOptions(options),
    options.sessionOptions,
  );
  const mode = applyDemoSessionMode(
    MediaSessionMode.File,
    options.sessionOptions,
  );
  const playbackGate = applyDemoSessionPlaybackGate(
    undefined,
    options.sessionOptions,
  );

  const engine = applyDemoEngineOptions({}, options.sessionOptions);

  options.onSessionConfiguration(
    resolveDemoSessionConfiguration({
      detections,
      engine,
      engineSource: DemoEngineSource.Blob,
      mediaPath: DemoMediaPath.Engine,
      mediaPathSupport: UPLOAD_MEDIA_PATH_BLOCKED,
      mode,
      normalizationSupport: UPLOAD_NORMALIZATION_BLOCKED,
      playbackGate,
      renderer,
    }),
  );

  const isImageUpload = options.uploadRun.file.type.startsWith("image/");
  let preparedMedia: PreparedUploadMedia | undefined;
  let sampleSink: DecodedVideoSampleSink | undefined;
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
      detections,
      media: options.tapMediaSource(
        tapSampleSink(
          createVideoEngineMediaRendererSource({
            ...engine,
            display: readDemoDisplayBox(
              options.container,
              options.renderQuality,
            ),
            source: {
              blob: preparedMedia?.blob ?? options.uploadRun.file,
              kind: SourceKind.Blob,
            },
          }),
          (opened) => {
            sampleSink = opened;
          },
        ),
      ),
      mode,
      presentation,
      onState: options.onSessionState,
      playbackGate,
      renderer,
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

  if (!sampleSink) {
    session.destroy();
    throw new Error("Upload media session opened no readable frame source.");
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
    sampleSink,
    session,
    uploadRun: options.uploadRun,
  });

  return session;
}

/** Hands the opened source's pull path to the inference pass, so the upload is
 *  read back through the media the player already demuxed. */
function tapSampleSink(
  source: MediaRendererSource,
  onSampleSink: (sampleSink: DecodedVideoSampleSink) => void,
): MediaRendererSource {
  return {
    async open() {
      const opened = await source.open();

      onSampleSink(opened.sampleSink);

      return opened;
    },
  };
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
  readonly sampleSink: DecodedVideoSampleSink;
  readonly session: MediaSession;
  readonly uploadRun: Pick<UploadRunRequest, "apiKey" | "classNames">;
}) {
  try {
    for await (const batch of extractInferenceFrameBatches({
      media: options.preparedMedia,
      sampleSink: options.sampleSink,
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
