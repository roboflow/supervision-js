import {
  DetectionFrameSelectionMode,
  MediaRendererFit,
  createMediaRenderer,
  type MediaRenderer,
} from "supervision-js";
import type {
  BasketballSampleDetectionSource,
  BasketballSampleFixtureDefinition,
} from "../fixtures/basketball-sample";
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
): Promise<{
  readonly detectionSource: BasketballSampleDetectionSource;
  readonly renderer: MediaRenderer;
}> {
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
  const renderer = await createMediaRenderer({
    autoPlay: false,
    boxStyle: presentation.boxStyle ?? undefined,
    container: options.container,
    detectionBuffer: {
      bufferAheadSeconds: UPLOAD_DETECTION_BUFFER_AHEAD_SECONDS,
      bufferBehindSeconds: UPLOAD_DETECTION_BUFFER_BEHIND_SECONDS,
      frameIndexOriginTime: 0,
      frameRate: manifest.inference.frameRate,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    },
    detectionSource: detectionSource.detectionSource,
    fit: MediaRendererFit.Contain,
    loop: true,
    maskStyle: presentation.maskStyle ?? undefined,
    onFrame: options.onFrame,
    onSource: options.onSourceState,
    src: mediaSource.src,
  });

  return { detectionSource, renderer };
}
