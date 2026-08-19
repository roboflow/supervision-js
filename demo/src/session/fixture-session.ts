import {
  DetectionFrameSelectionMode,
  MediaInteractionMode,
  RenderPreparationMode,
  MediaRendererFit,
  createMediaSession,
  type MediaSession,
  type MediaRendererPresentation,
} from "supervision";
import type {
  DemoFixtureDefinition,
  DemoFixtureFrameTransform,
} from "../fixtures/demo-fixtures";
import {
  createDemoFixtureDetectionSource,
  createDemoFixtureMedia,
  loadDemoFixtureDetectionManifest,
} from "../fixtures/demo-fixtures";
import { createDemoPresentation } from "../presentation/demo-presentation";
import { getDemoMaxDevicePixelRatio } from "./render-quality";
import type { DemoSessionCallbacks } from "./demo-session-types";

export async function createFixtureSession(
  options: {
    readonly container: HTMLDivElement;
    readonly definition: DemoFixtureDefinition;
    readonly fixtureFrameTransform?: DemoFixtureFrameTransform;
    readonly presentationTransform?: (
      presentation: MediaRendererPresentation,
    ) => MediaRendererPresentation;
  } & DemoSessionCallbacks,
): Promise<MediaSession> {
  const manifest = await loadDemoFixtureDetectionManifest(options.definition);
  const detectionSource = createDemoFixtureDetectionSource(
    manifest,
    options.definition,
    options.fixtureFrameTransform,
  );

  if (!options.isActive()) {
    detectionSource.destroy();
    throw new Error("Fixture session was canceled.");
  }

  options.onFixtureSummary(detectionSource.fixtureSummary);
  options.onDetectionSourceState({
    datasetId: detectionSource.datasetId,
    errorMessage: null,
    sourceSummary: detectionSource.sourceSummary,
    status: detectionSource.status,
  });

  options.onMediaState({
    errorMessage: null,
    status: options.definition.mediaReadyStatusLabel,
  });

  const basePresentation = createDemoPresentation(options.presentationSettings);
  const presentation =
    options.presentationTransform?.(basePresentation) ?? basePresentation;
  try {
    const session = await createMediaSession({
      container: options.container,
      detections: {
        source: detectionSource.detectionSource,
        sync: {
          frameIndexOriginTime: manifest.video.firstTimestamp ?? 0,
          frameRate: manifest.inference?.frameRate ?? manifest.frameRate,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: options.tapMediaSource(createDemoFixtureMedia(options.definition)),
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

    return session;
  } catch (error) {
    detectionSource.destroy();
    throw error;
  }
}
