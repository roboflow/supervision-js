import {
  DetectionFrameSelectionMode,
  MediaInteractionMode,
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
        source: detectionSource.detectionSource,
        sync: {
          frameIndexOriginTime: 0,
          frameRate: manifest.inference.frameRate,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: mediaSource.src,
      onState: options.onSessionState,
      presentation,
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

    return session;
  } catch (error) {
    detectionSource.destroy();
    throw error;
  }
}
