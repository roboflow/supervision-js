import {
  BaseBoxStyle,
  BaseInteractionStyle,
  BaseKeypointStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  DEFAULT_DETECTION_COLOR_SEQUENCE,
  DetectionPostProcessingMode,
  MaskRenderMode,
  TrackingGeometry,
  annotationRenderers,
  createBrowserColdDetectionFrameStore,
  createDetectionPostProcessingPipeline,
  createWritableDetectionFrameSource,
  detectionPostProcessors,
  type Detection,
  type DetectionFrameSource,
  type DetectionFrameSourceChanges,
  type DetectionFrameSourceVersionRange,
  type DetectionPostProcessingDiagnostics,
  type DetectionPostProcessingPipeline,
  type MediaRendererPresentation,
} from "supervision";
import type { DemoFixtureDetectionManifest } from "./fixtures/demo-fixtures";

const TRACKING_DATABASE_NAME = "supervision-docs-tracking-playground";
const TRACKING_DATASET_ID = "basketball-tracking-output";

export interface DocsTrackingRunOptions {
  readonly algorithm: DocsTrackingAlgorithm;
  readonly bufferRatioFirst: number;
  readonly bufferRatioSecond: number;
  readonly deltaT: number;
  readonly directionConsistencyWeight: number;
  readonly geometry: TrackingGeometry;
  readonly highConfidenceDetectionThreshold: number;
  readonly lostTrackBuffer: number;
  readonly minimumConsecutiveFrames: number;
  readonly minimumIouThreshold: number;
  readonly minimumIouThresholdSecondAssociation: number;
  readonly minimumIouThresholdUnconfirmedAssociation: number;
  readonly trackActivationThreshold: number;
  readonly onChunk?: (chunkIndex: number) => void;
  readonly onDiagnostics?: (
    diagnostics: DetectionPostProcessingDiagnostics,
  ) => void;
}

export type DocsTrackingPresentationMode = "raw" | "tracked";
export type DocsTrackingAlgorithm = "sort" | "bytetrack" | "cbiou" | "ocsort";

export interface DocsTrackingController extends DetectionFrameSource {
  attach(
    source: DetectionFrameSource,
    manifest: DemoFixtureDetectionManifest,
  ): void;
  cancel(): void;
  run(options: DocsTrackingRunOptions): Promise<void>;
  showRaw(): void;
}

export function createDocsTrackingController(): DocsTrackingController {
  const store = createBrowserColdDetectionFrameStore({
    databaseName: TRACKING_DATABASE_NAME,
  });
  const output = createWritableDetectionFrameSource({
    chunkDurationSeconds: 1,
    datasetId: TRACKING_DATASET_ID,
    store,
  });
  let rawSource: DetectionFrameSource | undefined;
  let manifest: DemoFixtureDetectionManifest | undefined;
  let activeSource: DetectionFrameSource | undefined;
  let pipeline: DetectionPostProcessingPipeline | undefined;
  let processing = Promise.resolve();
  let generation = 1;
  let runId = 0;
  let destroyed = false;

  return {
    attach(source, nextManifest) {
      assertActive();
      rawSource = source;
      manifest = nextManifest;
      activeSource = source;
      generation += 1;
    },

    cancel() {
      runId += 1;
      pipeline?.destroy();
      pipeline = undefined;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      runId += 1;
      pipeline?.destroy();
      output.destroy?.();
    },

    getAvailableRanges() {
      return activeSource?.getAvailableRanges?.() ?? [];
    },

    getChangesSince(
      previousVersion: number,
      ranges: readonly DetectionFrameSourceVersionRange[],
    ): DetectionFrameSourceChanges {
      const version = getVersion(ranges[0]);
      return {
        ranges: [],
        requiresReload: version !== previousVersion,
        version,
      };
    },

    getVersion(range) {
      return getVersion(range);
    },

    loadFrames(startTime, endTime) {
      assertActive();
      if (!activeSource) return Promise.resolve([]);
      return activeSource.loadFrames(startTime, endTime);
    },

    async run(options) {
      assertActive();
      if (!rawSource || !manifest) {
        throw new Error("Basketball tracking source is not ready.");
      }

      const source = rawSource;
      const fixtureManifest = manifest;
      const currentRunId = runId + 1;
      runId = currentRunId;
      const previousProcessing = processing;
      pipeline?.destroy();
      pipeline = undefined;

      const currentProcessing = (async () => {
        await previousProcessing.catch(() => undefined);
        if (currentRunId !== runId) return;
        await output.clear();
        if (currentRunId !== runId) return;
        activeSource = output;
        generation += 1;
        const trackingProcessor = (() => {
          switch (options.algorithm) {
            case "bytetrack":
              return detectionPostProcessors.tracking({
                algorithm: "bytetrack",
                geometry: options.geometry,
                highConfidenceDetectionThreshold:
                  options.highConfidenceDetectionThreshold,
                lostTrackBuffer: options.lostTrackBuffer,
                minimumConsecutiveFrames: options.minimumConsecutiveFrames,
                minimumIouThreshold: options.minimumIouThreshold,
                trackActivationThreshold: options.trackActivationThreshold,
              });
            case "cbiou":
              return detectionPostProcessors.tracking({
                algorithm: "cbiou",
                bufferRatioFirst: options.bufferRatioFirst,
                bufferRatioSecond: options.bufferRatioSecond,
                geometry: options.geometry,
                highConfidenceDetectionThreshold:
                  options.highConfidenceDetectionThreshold,
                lostTrackBuffer: options.lostTrackBuffer,
                minimumConsecutiveFrames: options.minimumConsecutiveFrames,
                minimumIouThresholdFirstAssociation:
                  options.minimumIouThreshold,
                minimumIouThresholdSecondAssociation:
                  options.minimumIouThresholdSecondAssociation,
                minimumIouThresholdUnconfirmedAssociation:
                  options.minimumIouThresholdUnconfirmedAssociation,
                trackActivationThreshold: options.trackActivationThreshold,
              });
            case "ocsort":
              return detectionPostProcessors.tracking({
                algorithm: "ocsort",
                deltaT: options.deltaT,
                directionConsistencyWeight: options.directionConsistencyWeight,
                geometry: options.geometry,
                highConfidenceDetectionThreshold:
                  options.highConfidenceDetectionThreshold,
                lostTrackBuffer: options.lostTrackBuffer,
                minimumConsecutiveFrames: options.minimumConsecutiveFrames,
                minimumIouThreshold: options.minimumIouThreshold,
              });
            case "sort":
              return detectionPostProcessors.tracking({
                algorithm: "sort",
                geometry: options.geometry,
                lostTrackBuffer: options.lostTrackBuffer,
                minimumConsecutiveFrames: options.minimumConsecutiveFrames,
                minimumIouThreshold: options.minimumIouThreshold,
                trackActivationThreshold: options.trackActivationThreshold,
              });
          }
        })();
        const currentPipeline = createDetectionPostProcessingPipeline({
          maxPendingFrames: Math.max(
            45,
            ...fixtureManifest.chunks.map((chunk) => chunk.frameCount + 4),
          ),
          mode: DetectionPostProcessingMode.Worker,
          mutateInput: false,
          onDiagnostics: options.onDiagnostics,
          output,
          processors: [trackingProcessor],
          startFrameIndex: 0,
        });
        pipeline = currentPipeline;

        for (const chunk of fixtureManifest.chunks) {
          if (currentRunId !== runId) return;
          const frames = await source.loadFrames(
            chunk.startTime,
            chunk.endTime,
          );
          const futureFrames = frames.filter(
            (frame) => (frame.frameIndex ?? 0) % 2 === 1,
          );
          const currentFrames = frames.filter(
            (frame) => (frame.frameIndex ?? 0) % 2 === 0,
          );

          // Deliberately enqueue later frames first. The public pipeline holds a
          // bounded set of references, then drains only from the causal frontier.
          await currentPipeline.appendFrames(futureFrames);
          await nextPaint();
          await currentPipeline.appendFrames(currentFrames);
          options.onChunk?.(chunk.chunkIndex);
          await nextPaint();
        }
      })();
      processing = currentProcessing;
      await currentProcessing;
    },

    showRaw() {
      assertActive();
      runId += 1;
      pipeline?.destroy();
      pipeline = undefined;
      activeSource = rawSource;
      generation += 1;
    },
  };

  function getVersion(range?: DetectionFrameSourceVersionRange) {
    return generation * 1_000_000 + (activeSource?.getVersion?.(range) ?? 0);
  }

  function assertActive() {
    if (destroyed) {
      throw new Error("Docs tracking controller has been destroyed.");
    }
  }
}

export function createDocsTrackingPresentation(
  geometry: TrackingGeometry,
  mode: DocsTrackingPresentationMode = "tracked",
): MediaRendererPresentation {
  const isRaw = mode === "raw";
  const shouldRenderObserved = (detection: Detection) =>
    (isRaw || detection.trackerId !== undefined) &&
    hasGeometry(detection, geometry);
  const shouldRenderLabel = (detection: Detection) =>
    isRaw
      ? hasGeometry(detection, geometry)
      : detection.trackerId !== undefined && shouldRenderObserved(detection);
  const boxStyle = new BaseBoxStyle({
    cornerRadius: 1,
    fill: (detection) => ({
      alpha: 0.08,
      color: getTrackStyle(detection).fill,
    }),
    shouldRender: (detection) =>
      geometry === TrackingGeometry.Box && shouldRenderObserved(detection),
    stroke: (detection) => ({
      alpha: 1,
      color: getTrackStyle(detection).stroke,
      width: 2,
    }),
  });
  const maskStyle =
    geometry === TrackingGeometry.Mask
      ? new BaseMaskStyle({
          color: (detection) => getTrackStyle(detection).fill,
          fillAlpha: 0.45,
          mode: MaskRenderMode.FillAndStroke,
          opacity: 1,
          shouldRender: shouldRenderObserved,
          stroke: (detection) => ({
            color: getTrackStyle(detection).stroke,
            width: 2,
          }),
        })
      : null;
  const keypointStyle =
    geometry === TrackingGeometry.Keypoints
      ? new BaseKeypointStyle({
          edgeShadowStroke: { alpha: 0.25, color: 0x000000, width: 3 },
          edgeStroke: (detection) => ({
            color: getTrackStyle(detection).stroke,
            width: 1.5,
          }),
          markerFill: (detection) => ({
            color: getTrackStyle(detection).fill,
          }),
          markerStroke: { alpha: 1, color: 0xffffff, width: 1 },
          radius: 3.5,
          shouldRender: shouldRenderObserved,
        })
      : null;
  const labelStyle = new BaseLabelStyle({
    background: (detection) => ({
      alpha: 1,
      color: getTrackStyle(detection).labelBackground,
      cornerRadius: 4,
      paddingX: 6,
      paddingY: 3,
      topCornersOnly: true,
    }),
    shouldRender: shouldRenderLabel,
    text: (detection) =>
      detection.trackerId === undefined
        ? undefined
        : `${detection.className ?? "object"} #${detection.trackerId}`,
    textStyle: (detection) => ({
      color: getTrackStyle(detection).labelText,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 12,
      fontWeight: "600",
    }),
  });
  const interactionStyle = new BaseInteractionStyle({
    hovered: createDocsTrackingInteractionPresentation(
      geometry,
      shouldRenderObserved,
      false,
    ),
    selected: createDocsTrackingInteractionPresentation(
      geometry,
      shouldRenderObserved,
      true,
    ),
    shouldRender: shouldRenderObserved,
  });

  return {
    backgroundColor: 0xf3f4f6,
    boxStyle,
    focusStyle: null,
    interactionStyle,
    keypointStyle,
    labelStyle,
    maskStyle,
    polygonStyle: null,
    polylineStyle: null,
    renderers: [
      ...(maskStyle ? [annotationRenderers.mask({ style: maskStyle })] : []),
      annotationRenderers.box({ style: boxStyle }),
      ...(keypointStyle
        ? [annotationRenderers.keypoints({ style: keypointStyle })]
        : []),
      annotationRenderers.label({ style: labelStyle }),
    ],
  };
}

function createDocsTrackingInteractionPresentation(
  geometry: TrackingGeometry,
  shouldRender: (detection: Detection) => boolean,
  selected: boolean,
) {
  if (geometry === TrackingGeometry.Mask) {
    return {
      boxStyle: null,
      keypointStyle: null,
      maskStyle: new BaseMaskStyle({
        color: (detection) => getTrackStyle(detection).fill,
        fillAlpha: selected ? 0.2 : 0.12,
        mode: MaskRenderMode.FillAndStroke,
        opacity: 1,
        shouldRender,
        stroke: (detection) => ({
          color: getTrackStyle(detection).stroke,
          width: selected ? 7 : 5,
        }),
      }),
    };
  }

  if (geometry === TrackingGeometry.Keypoints) {
    return {
      boxStyle: null,
      keypointStyle: new BaseKeypointStyle({
        edgeShadowStroke: {
          alpha: 0.35,
          color: 0x000000,
          width: selected ? 6 : 5,
        },
        edgeStroke: (detection) => ({
          color: getTrackStyle(detection).stroke,
          width: selected ? 4 : 3,
        }),
        markerFill: (detection) => ({
          color: getTrackStyle(detection).fill,
        }),
        markerStroke: { alpha: 1, color: 0xffffff, width: 2 },
        radius: selected ? 6 : 5,
        shouldRender,
      }),
      maskStyle: null,
    };
  }

  return {
    boxStyle: new BaseBoxStyle({
      cornerRadius: 1,
      fill: (detection) => ({
        alpha: selected ? 0.18 : 0.12,
        color: getTrackStyle(detection).fill,
      }),
      shouldRender,
      stroke: (detection) => ({
        alpha: 1,
        color: getTrackStyle(detection).stroke,
        width: selected ? 5 : 4,
      }),
    }),
    keypointStyle: null,
    maskStyle: null,
  };
}

export function createDocsTrackingSnippet(
  options: Omit<DocsTrackingRunOptions, "onChunk" | "onDiagnostics">,
) {
  const algorithmOptions = createAlgorithmSnippetOptions(options);
  return `const pipeline = createDetectionPostProcessingPipeline({
  mutateInput: false, // Keep raw frames for this comparison playground.
  processors: [
    detectionPostProcessors.tracking({
      algorithm: "${options.algorithm}",${algorithmOptions}
      geometry: TrackingGeometry.${geometryName(options.geometry)},
      lostTrackBuffer: ${options.lostTrackBuffer},
      minimumConsecutiveFrames: ${options.minimumConsecutiveFrames},
    }),
  ],
  output: trackedSource,
});

// Safe for out-of-order SSE arrivals.
await pipeline.appendFrames([detectionFrame]);`;
}

function createAlgorithmSnippetOptions(
  options: Omit<DocsTrackingRunOptions, "onChunk" | "onDiagnostics">,
) {
  switch (options.algorithm) {
    case "bytetrack":
      return `
      highConfidenceDetectionThreshold: ${options.highConfidenceDetectionThreshold.toFixed(2)},
      minimumIouThreshold: ${options.minimumIouThreshold.toFixed(2)},
      trackActivationThreshold: ${options.trackActivationThreshold.toFixed(2)},`;
    case "cbiou":
      return `
      bufferRatioFirst: ${options.bufferRatioFirst.toFixed(2)},
      bufferRatioSecond: ${options.bufferRatioSecond.toFixed(2)},
      highConfidenceDetectionThreshold: ${options.highConfidenceDetectionThreshold.toFixed(2)},
      minimumIouThresholdFirstAssociation: ${options.minimumIouThreshold.toFixed(2)},
      minimumIouThresholdSecondAssociation: ${options.minimumIouThresholdSecondAssociation.toFixed(2)},
      minimumIouThresholdUnconfirmedAssociation: ${options.minimumIouThresholdUnconfirmedAssociation.toFixed(2)},
      trackActivationThreshold: ${options.trackActivationThreshold.toFixed(2)},`;
    case "ocsort":
      return `
      deltaT: ${options.deltaT},
      directionConsistencyWeight: ${options.directionConsistencyWeight.toFixed(2)},
      highConfidenceDetectionThreshold: ${options.highConfidenceDetectionThreshold.toFixed(2)},
      minimumIouThreshold: ${options.minimumIouThreshold.toFixed(2)},`;
    case "sort":
      return `
      minimumIouThreshold: ${options.minimumIouThreshold.toFixed(2)},
      trackActivationThreshold: ${options.trackActivationThreshold.toFixed(2)},`;
  }
}

function hasGeometry(detection: Detection, geometry: TrackingGeometry) {
  if (geometry === TrackingGeometry.Mask) return detection.mask !== undefined;
  if (geometry === TrackingGeometry.Keypoints)
    return detection.keypoints !== undefined;
  return detection.rect !== undefined;
}

function getTrackStyle(detection: Detection) {
  const index =
    detection.trackerId === undefined
      ? hashClassName(detection.className)
      : detection.trackerId;
  return DEFAULT_DETECTION_COLOR_SEQUENCE[
    index % DEFAULT_DETECTION_COLOR_SEQUENCE.length
  ]!;
}

function hashClassName(className: string | undefined) {
  if (!className) return 0;
  let hash = 0;
  for (let index = 0; index < className.length; index += 1) {
    hash = (hash * 31 + className.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function geometryName(geometry: TrackingGeometry) {
  if (geometry === TrackingGeometry.Mask) return "Mask";
  if (geometry === TrackingGeometry.Keypoints) return "Keypoints";
  return "Box";
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
