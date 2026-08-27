import {
  DetectionFrameSelectionMode,
  MediaSessionMode,
  createMediaSession,
  type MediaSession,
  type MediaSessionDetectionOptions,
  type MediaSessionMedia,
  type MediaRendererPresentation,
} from "supervision";
import type {
  DemoFixtureDefinition,
  DemoFixtureDetectionSourceTransform,
  DemoFixtureFrameTransform,
} from "../fixtures/demo-fixtures";
import {
  createDemoFixtureDetectionSource,
  createDemoFixtureMedia,
  loadDemoFixtureDetectionManifest,
  resolveDemoFixturePlaybackSrc,
} from "../fixtures/demo-fixtures";
import { createDemoPresentation } from "../presentation/demo-presentation";
import { readDemoDisplayBox } from "./decode-resolution";
import { readDemoSourceResidency } from "./source-residency";
import { createDemoRendererOptions } from "./demo-session-renderer";
import type { DemoSessionCallbacks } from "./demo-session-types";
import {
  applyDemoDetectionOptions,
  applyDemoRendererOptions,
  applyDemoSessionMode,
  applyDemoSessionPlaybackGate,
  buildDemoNormalization,
  normalizationSupported,
  resolveDemoSessionConfiguration,
} from "./session-options";

/**
 * A fixture ships its detections with it, so a playground that opens
 * unannotated is only ever waiting on preparation.
 */
const FIXTURE_PLAYBACK_GATE = true;

export async function createFixtureSession(
  options: {
    readonly container: HTMLDivElement;
    readonly definition: DemoFixtureDefinition;
    readonly fixtureFrameTransform?: DemoFixtureFrameTransform;
    readonly fixtureDetectionSourceTransform?: DemoFixtureDetectionSourceTransform;
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
    options.fixtureDetectionSourceTransform,
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
  const baseDetections: MediaSessionDetectionOptions = {
    source: detectionSource.detectionSource,
    sync: {
      frameRate: manifest.inference?.frameRate ?? manifest.frameRate,
      // A v2 fixture records each frame's real [mediaTime, endTime), so
      // interval pairing is exact even on VFR sources; index-times-rate
      // reconstruction stays only for v1 proxy fixtures that lack it.
      selectionMode:
        manifest.video.firstTimestamp === undefined
          ? DetectionFrameSelectionMode.NearestFrameIndex
          : DetectionFrameSelectionMode.Interval,
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
    FIXTURE_PLAYBACK_GATE,
    options.sessionOptions,
  );
  const normalize = buildDemoNormalization(options.sessionOptions);

  options.onSessionConfiguration(
    resolveDemoSessionConfiguration({
      detections,
      mode,
      normalizable: normalizationSupported,
      playbackGate,
      renderer,
    }),
  );

  try {
    const session = await createMediaSession({
      container: options.container,
      detections,
      media: await createFixtureSessionMedia({
        container: options.container,
        definition: options.definition,
        normalizing: normalize !== undefined,
        renderQuality: options.renderQuality,
        tapMediaSource: options.tapMediaSource,
      }),
      mode,
      onState: options.onSessionState,
      playbackGate,
      presentation,
      renderer,
      ...(normalize ? { normalize } : {}),
    });

    return session;
  } catch (error) {
    detectionSource.destroy();
    throw error;
  }
}

/**
 * `normalize` acts on a `Blob` and nothing else, so asking for it also decides
 * how the clip opens. The session then builds a renderer source of its own,
 * and the engine source this otherwise hands it never reaches the renderer.
 */
async function createFixtureSessionMedia(options: {
  readonly container: HTMLDivElement;
  readonly definition: DemoFixtureDefinition;
  readonly normalizing: boolean;
  readonly renderQuality: DemoSessionCallbacks["renderQuality"];
  readonly tapMediaSource: DemoSessionCallbacks["tapMediaSource"];
}): Promise<MediaSessionMedia> {
  if (!options.normalizing) {
    return options.tapMediaSource(
      createDemoFixtureMedia(
        options.definition,
        readDemoDisplayBox(options.container, options.renderQuality),
        readDemoSourceResidency(globalThis.location?.search ?? ""),
      ),
    );
  }

  const response = await fetch(
    resolveDemoFixturePlaybackSrc(options.definition),
  );

  return await response.blob();
}
