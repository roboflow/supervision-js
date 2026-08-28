import {
  DetectionFrameSelectionMode,
  MediaSessionMode,
  createMediaSession,
  type MediaSession,
  type MediaSessionDetectionOptions,
  type MediaSessionMedia,
  type MediaSessionNormalizationOptions,
  type MediaRendererPresentation,
} from "supervision";
import type {
  DemoFixtureDefinition,
  DemoFixtureDetectionManifest,
  DemoFixtureDetectionSourceTransform,
  DemoFixtureFrameTransform,
} from "../fixtures/demo-fixtures";
import {
  createDemoFixtureDetectionSource,
  createDemoFixtureMedia,
  loadDemoFixtureDetectionManifest,
  resolveDemoFixturePlaybackSrc,
} from "../fixtures/demo-fixtures";
import { PipelineNodeId } from "../pipeline/pipeline-descriptor";
import type { PipelineRecorder } from "../pipeline/pipeline-recorder";
import {
  createDemoPresentation,
  demoPresentationDrawsAnnotations,
} from "../presentation/demo-presentation";
import { readDemoDisplayBox } from "./decode-resolution";
import { readDemoSourceResidency } from "./source-residency";
import { createDemoRendererOptions } from "./demo-session-renderer";
import type { DemoSessionCallbacks } from "./demo-session-types";
import {
  applyDemoDetectionOptions,
  applyDemoEngineOptions,
  applyDemoMediaPath,
  applyDemoRendererOptions,
  applyDemoSessionMode,
  applyDemoSessionPlaybackGate,
  buildDemoNormalization,
  DemoEngineSource,
  DemoMediaPath,
  describeMissingSupport,
  optionSupported,
  resolveDemoSessionConfiguration,
  type DemoEngineOptions,
} from "./session-options";

/**
 * A fixture ships its detections with it, so a playground that opens
 * unannotated is only ever waiting on preparation.
 */
const FIXTURE_PLAYBACK_GATE = true;

const ENGINE_PATH_NORMALIZATION_BLOCKED = describeMissingSupport(
  "Converting the file replaces it with the conversion, and the video engine never opens that. Switch the media path to Mediabunny to convert.",
);

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
  const readPresentationSettings =
    options.readPresentationSettings ?? (() => options.presentationSettings);
  const baseDetections: MediaSessionDetectionOptions = {
    buffer: {
      // Fixture detections are chunk files fetched over the same link the
      // video is read over, and a workbench with every layer switched off
      // draws none of them. The window it already holds stays loaded, so
      // switching a layer back on annotates the frame on screen at once.
      enabled: () =>
        demoPresentationDrawsAnnotations(readPresentationSettings()),
    },
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

  recordFixtureDetectionSelection(options.pipeline, detections, manifest);
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
  const mediaPath = applyDemoMediaPath(options.sessionOptions);
  const normalize = buildDemoNormalization(mediaPath, options.sessionOptions);

  recordFixtureConditioning(options.pipeline, mediaPath, normalize);
  const engine = applyDemoEngineOptions(
    {
      sourceResidency: readDemoSourceResidency(
        globalThis.location?.search ?? "",
      ),
    },
    options.sessionOptions,
  );

  options.onSessionConfiguration(
    resolveDemoSessionConfiguration({
      detections,
      engine,
      engineSource:
        mediaPath === DemoMediaPath.Engine
          ? DemoEngineSource.Url
          : DemoEngineSource.None,
      mediaPath,
      mediaPathSupport: optionSupported,
      mode,
      normalizationSupport:
        mediaPath === DemoMediaPath.Engine
          ? ENGINE_PATH_NORMALIZATION_BLOCKED
          : optionSupported,
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
        engine,
        mediaPath,
        normalizing: normalize !== undefined,
        pipeline: options.pipeline,
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
 * `normalize` acts on a `Blob` and nothing else, so converting the clip means
 * fetching the whole file up front.
 */
async function createFixtureSessionMedia(options: {
  readonly container: HTMLDivElement;
  readonly definition: DemoFixtureDefinition;
  readonly engine: DemoEngineOptions;
  readonly mediaPath: DemoMediaPath;
  readonly normalizing: boolean;
  readonly pipeline: PipelineRecorder;
  readonly renderQuality: DemoSessionCallbacks["renderQuality"];
  readonly tapMediaSource: DemoSessionCallbacks["tapMediaSource"];
}): Promise<MediaSessionMedia> {
  const playbackSrc = resolveDemoFixturePlaybackSrc(options.definition);

  recordFixtureIntake(options.pipeline, options.definition, playbackSrc);

  if (options.mediaPath === DemoMediaPath.Engine) {
    options.pipeline.bypass(
      PipelineNodeId.IntakeConversionRefetch,
      "The video engine fetches the clip in ranges as it needs them, so nothing downloaded it up front.",
    );

    return options.tapMediaSource(
      createDemoFixtureMedia(
        options.definition,
        readDemoDisplayBox(options.container, options.renderQuality),
        options.engine,
      ),
    );
  }

  if (!options.normalizing) {
    options.pipeline.bypass(
      PipelineNodeId.IntakeConversionRefetch,
      "The clip is played from its address, so nothing had to download it in one piece first.",
    );

    return playbackSrc;
  }

  const response = await fetch(playbackSrc);
  const blob = await response.blob();

  options.pipeline.record(
    PipelineNodeId.IntakeConversionRefetch,
    FIXTURE_MEDIA_SITE,
    [{ label: "downloaded", value: `${blob.size} bytes` }],
  );

  return blob;
}

const FIXTURE_SITE = "demo/session/fixture-session.ts › createFixtureSession";
const FIXTURE_MEDIA_SITE =
  "demo/session/fixture-session.ts › createFixtureSessionMedia";

function recordFixtureIntake(
  pipeline: PipelineRecorder,
  definition: DemoFixtureDefinition,
  playbackSrc: string,
) {
  pipeline.record(PipelineNodeId.IntakeFixtureUrl, FIXTURE_MEDIA_SITE, [
    { label: "sample", value: definition.displayName },
    { label: "playing", value: fileName(playbackSrc) },
  ]);

  if (definition.proxyVideoSrc === null) {
    pipeline.bypass(
      PipelineNodeId.IntakeFixtureProxy,
      "This sample has no stand-in, so the file on screen is the file being played.",
    );
  } else {
    pipeline.record(PipelineNodeId.IntakeFixtureProxy, FIXTURE_MEDIA_SITE, [
      { label: "named file", value: fileName(definition.videoSrc) },
      { label: "played instead", value: fileName(definition.proxyVideoSrc) },
      {
        label: "why",
        value:
          "the detections were computed against this copy, so playing the named file would draw every box on the wrong frame",
      },
    ]);
  }

  pipeline.bypass(
    PipelineNodeId.IntakeUploadFile,
    "This session is playing a sample clip, not a file from your machine.",
  );
  pipeline.bypass(
    PipelineNodeId.IntakeUploadImageRecode,
    "Nothing was uploaded, so there was no still picture to re-encode.",
  );
}

function recordFixtureConditioning(
  pipeline: PipelineRecorder,
  mediaPath: DemoMediaPath,
  normalize: MediaSessionNormalizationOptions | undefined,
) {
  const engineDriven = mediaPath === DemoMediaPath.Engine;
  const notConverted = engineDriven
    ? "The video engine is driving this clip and reads the file itself, so converting it was never offered here."
    : "Nothing asked for the clip to be converted.";

  if (normalize === undefined) {
    pipeline.record(PipelineNodeId.ConditioningNone, FIXTURE_SITE);
    pipeline.bypass(PipelineNodeId.ConditioningWholeFile, notConverted);
    pipeline.bypass(PipelineNodeId.ConditioningProgressive, notConverted);
    return;
  }

  const streaming = normalize.stream === true;

  pipeline.bypass(
    PipelineNodeId.ConditioningNone,
    "The clip was converted before it reached the screen.",
  );
  pipeline.record(
    streaming
      ? PipelineNodeId.ConditioningProgressive
      : PipelineNodeId.ConditioningWholeFile,
    FIXTURE_SITE,
    [
      {
        label: "container",
        value: normalize.container ?? "left to the library",
      },
    ],
  );
  pipeline.bypass(
    streaming
      ? PipelineNodeId.ConditioningWholeFile
      : PipelineNodeId.ConditioningProgressive,
    streaming
      ? "The conversion is being read as it is written, so nothing waited for a finished file."
      : "The conversion was asked for in one piece, so playback waited for all of it.",
  );
}

/**
 * Which rule pairs a detection with a picture. A sample recorded before the
 * fixtures carried per-frame times has to count frames from the start; one that
 * carries them is paired on the stretch of time each detection covers, which is
 * exact even when the clip's frames are unevenly spaced.
 */
function recordFixtureDetectionSelection(
  pipeline: PipelineRecorder,
  detections: MediaSessionDetectionOptions,
  manifest: DemoFixtureDetectionManifest,
) {
  const byInterval =
    detections.sync?.selectionMode === DetectionFrameSelectionMode.Interval;
  const frameRate = detections.sync?.frameRate ?? manifest.frameRate;

  pipeline.record(
    byInterval
      ? PipelineNodeId.DetectionsInterval
      : PipelineNodeId.DetectionsNearestFrameIndex,
    FIXTURE_SITE,
    [
      { label: "detections a second", value: String(frameRate) },
      {
        label: "why",
        value: byInterval
          ? "this sample records the stretch of time every detection covers"
          : "this sample records no per-detection times, so its position has to be rebuilt from the count",
      },
    ],
  );
  pipeline.bypass(
    byInterval
      ? PipelineNodeId.DetectionsNearestFrameIndex
      : PipelineNodeId.DetectionsInterval,
    byInterval
      ? "Counting frames from the start is only needed when a sample records no times of its own."
      : "This sample records no per-detection times, so there is no stretch of time to pair against.",
  );
}

function fileName(src: string) {
  return src.split("/").pop() ?? src;
}
