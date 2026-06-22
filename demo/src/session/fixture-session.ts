import {
  DetectionFrameSelectionMode,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaInteractionMode,
  MediaRendererFit,
  createMediaSession,
  type MediaSession,
} from "supervision-js";
import type { Sam3FixtureDefinition } from "../fixtures/sam3-fixtures";
import {
  createSam3FixtureDetectionSource,
  loadSam3FixtureDetectionManifest,
  loadSam3FixtureMedia,
} from "../fixtures/sam3-fixtures";
import {
  NORMALIZED_UPLOAD_VIDEO_BITRATE,
  TARGET_UPLOAD_FRAME_RATE,
} from "../media/upload-media";
import { createDemoPresentation } from "../presentation/demo-presentation";
import { getDemoMaxDevicePixelRatio } from "./render-quality";
import type { DemoSessionCallbacks } from "./demo-session-types";

export async function createFixtureSession(
  options: {
    readonly container: HTMLDivElement;
    readonly definition: Sam3FixtureDefinition;
  } & DemoSessionCallbacks,
): Promise<MediaSession> {
  const manifest = await loadSam3FixtureDetectionManifest(options.definition);
  const detectionSource = createSam3FixtureDetectionSource(
    manifest,
    options.definition,
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

  const mediaSource = await loadSam3FixtureMedia(options.definition);

  if (!options.isActive()) {
    detectionSource.destroy();
    throw new Error("Fixture session was canceled.");
  }

  options.onMediaState({
    errorMessage: mediaSource.error?.message ?? null,
    status: mediaSource.statusLabel,
  });

  const presentation = createDemoPresentation(options.presentationSettings);
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
      media: mediaSource.media,
      normalize: mediaSource.normalizeInBrowser
        ? {
            audio: { discard: true },
            container: MediaNormalizationContainer.WebM,
            stream: true,
            video: {
              bitrate: NORMALIZED_UPLOAD_VIDEO_BITRATE,
              codec: MediaNormalizationVideoCodec.Vp9,
              forceTranscode: true,
              frameRate: TARGET_UPLOAD_FRAME_RATE,
              keyFrameInterval: 1,
            },
          }
        : false,
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
