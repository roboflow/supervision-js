import {
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
  UPLOAD_DETECTION_BUFFER_AHEAD_SECONDS,
  UPLOAD_DETECTION_BUFFER_BEHIND_SECONDS,
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

  try {
    const session = await createMediaSession({
      container: options.container,
      detections: {
        buffer: {
          bufferAheadSeconds: UPLOAD_DETECTION_BUFFER_AHEAD_SECONDS,
          bufferBehindSeconds: UPLOAD_DETECTION_BUFFER_BEHIND_SECONDS,
        },
        source: detectionSource.detectionSource,
      },
      media: mediaSource.src,
      presentation,
      renderer: {
        autoPlay: false,
        fit: MediaRendererFit.Contain,
        loop: true,
        onFrame: options.onFrame,
        onState: options.onRendererState,
        renderPreparation: {
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
