import {
  DetectionFrameSelectionMode,
  MediaRendererFit,
  createMediaSession,
  type MediaSession,
} from "supervision-js";
import type { BasketballSampleFixtureDefinition } from "../fixtures/basketball-sample";
import {
  createBasketballSampleDetectionSource,
  loadBasketballSampleDetectionManifest,
  loadBasketballSampleMedia,
} from "../fixtures/basketball-sample";
import { createBasketballSamplePresentation } from "../presentation/basketball-presentation";
import {
  BASKETBALL_DETECTION_BUFFER_AHEAD_SECONDS,
  BASKETBALL_DETECTION_BUFFER_BEHIND_SECONDS,
  BASKETBALL_DETECTION_BUFFER_REFRESH_SECONDS,
  BASKETBALL_MASK_FRAME_CACHE_SECONDS,
  BASKETBALL_MASK_FRAME_MAX_PENDING_COUNT,
  BASKETBALL_MASK_FRAME_PREFETCH_SECONDS,
  BASKETBALL_MASK_FRAME_SCAN_INTERVAL_SECONDS,
  BASKETBALL_MASK_FRAME_SCHEDULE_BATCH_SIZE,
} from "./demo-session-config";
import type { DemoSessionCallbacks } from "./demo-session-types";

export async function createBasketballSession(
  options: {
    readonly container: HTMLDivElement;
    readonly definition: BasketballSampleFixtureDefinition;
  } & DemoSessionCallbacks,
): Promise<MediaSession> {
  const manifest = await loadBasketballSampleDetectionManifest(
    options.definition,
  );
  const detectionSource = createBasketballSampleDetectionSource(
    manifest,
    options.definition,
  );

  if (!options.isActive()) {
    detectionSource.destroy();
    throw new Error("Basketball session was canceled.");
  }

  options.onFixtureSummary(detectionSource.fixtureSummary);
  options.onDetectionSourceState({
    datasetId: detectionSource.datasetId,
    errorMessage: null,
    sourceSummary: detectionSource.sourceSummary,
    status: detectionSource.status,
  });

  const mediaSource = await loadBasketballSampleMedia(options.definition);

  if (!options.isActive()) {
    detectionSource.destroy();
    throw new Error("Basketball session was canceled.");
  }

  options.onMediaState({
    errorMessage: mediaSource.error?.message ?? null,
    status: mediaSource.statusLabel,
  });

  const presentation = createBasketballSamplePresentation(
    options.presentationSettings,
  );
  const maskFrameCacheCount = secondsToFrameCount(
    BASKETBALL_MASK_FRAME_CACHE_SECONDS,
    manifest.inference.frameRate,
  );
  const maskFramePrefetchCount = secondsToFrameCount(
    BASKETBALL_MASK_FRAME_PREFETCH_SECONDS,
    manifest.inference.frameRate,
  );

  try {
    const session = await createMediaSession({
      container: options.container,
      detections: {
        buffer: {
          bufferAheadSeconds: BASKETBALL_DETECTION_BUFFER_AHEAD_SECONDS,
          bufferBehindSeconds: BASKETBALL_DETECTION_BUFFER_BEHIND_SECONDS,
          frameIndexOriginTime: 0,
          frameRate: manifest.inference.frameRate,
          refreshIntervalSeconds: BASKETBALL_DETECTION_BUFFER_REFRESH_SECONDS,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        source: detectionSource.detectionSource,
      },
      media: mediaSource.src,
      onState: options.onSessionState,
      presentation,
      renderer: {
        autoPlay: false,
        fit: MediaRendererFit.Contain,
        loop: true,
        onFrame: options.onFrame,
        onState: options.onRendererState,
        renderPreparation: {
          maskFrame: {
            maxCacheFrameCount: maskFrameCacheCount,
            maxPendingFrameCount: BASKETBALL_MASK_FRAME_MAX_PENDING_COUNT,
            prefetchFrameCount: maskFramePrefetchCount,
            scanIntervalSeconds: BASKETBALL_MASK_FRAME_SCAN_INTERVAL_SECONDS,
            scheduleBatchSize: BASKETBALL_MASK_FRAME_SCHEDULE_BATCH_SIZE,
          },
          onDiagnostics: options.onRenderPreparationDiagnostics,
        },
        onSource: options.onSourceState,
      },
    });

    return session;
  } catch (error) {
    detectionSource.destroy();
    throw error;
  }
}

function secondsToFrameCount(seconds: number, frameRate: number) {
  return Math.max(1, Math.ceil(seconds * frameRate));
}
