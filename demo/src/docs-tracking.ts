import {
  BaseBoxStyle,
  BaseKeypointStyle,
  BaseLabelStyle,
  BaseMaskStyle,
  DEFAULT_DETECTION_COLOR_SEQUENCE,
  DetectionPostProcessingMode,
  DetectionTrackerState,
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
  readonly geometry: TrackingGeometry;
  readonly iouThreshold: number;
  readonly maxAge: number;
  readonly onChunk?: (chunkIndex: number) => void;
  readonly onDiagnostics?: (
    diagnostics: DetectionPostProcessingDiagnostics,
  ) => void;
}

export type DocsTrackingPresentationMode = "raw" | "tracked";

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

      const currentRunId = runId + 1;
      runId = currentRunId;
      pipeline?.destroy();
      await output.clear();
      if (currentRunId !== runId) return;
      activeSource = output;
      generation += 1;
      pipeline = createDetectionPostProcessingPipeline({
        maxPendingFrames: Math.max(
          45,
          ...manifest.chunks.map((chunk) => chunk.frameCount + 4),
        ),
        mode: DetectionPostProcessingMode.Worker,
        mutateInput: false,
        onDiagnostics: options.onDiagnostics,
        output,
        processors: [
          detectionPostProcessors.tracking({
            geometry: options.geometry,
            iouThreshold: options.iouThreshold,
            maxAge: options.maxAge,
          }),
        ],
        startFrameIndex: 0,
      });

      for (const chunk of manifest.chunks) {
        if (currentRunId !== runId) return;
        const frames = await rawSource.loadFrames(
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
        await pipeline.appendFrames(futureFrames);
        await nextPaint();
        await pipeline.appendFrames(currentFrames);
        options.onChunk?.(chunk.chunkIndex);
        await nextPaint();
      }
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
    (isRaw ||
      (detection.trackerId !== undefined &&
        detection.trackerState !== DetectionTrackerState.Predicted)) &&
    hasGeometry(detection, geometry);
  const shouldRenderLabel = (detection: Detection) =>
    isRaw
      ? hasGeometry(detection, geometry)
      : detection.trackerId !== undefined &&
        (detection.trackerState === DetectionTrackerState.Predicted ||
          hasGeometry(detection, geometry));
  const boxStyle = new BaseBoxStyle({
    fill: (detection) => ({
      alpha:
        detection.trackerState === DetectionTrackerState.Predicted
          ? 0.04
          : 0.12,
      color: getTrackStyle(detection).fill,
    }),
    shouldRender: (detection) =>
      (!isRaw && detection.trackerState === DetectionTrackerState.Predicted) ||
      (geometry === TrackingGeometry.Box && shouldRenderObserved(detection)),
    stroke: (detection) => ({
      alpha:
        detection.trackerState === DetectionTrackerState.Predicted ? 0.72 : 1,
      color: getTrackStyle(detection).stroke,
      dash:
        detection.trackerState === DetectionTrackerState.Predicted
          ? [8, 6]
          : undefined,
      width: detection.trackerState === DetectionTrackerState.Predicted ? 2 : 3,
    }),
  });
  const maskStyle =
    geometry === TrackingGeometry.Mask
      ? new BaseMaskStyle({
          color: (detection) => getTrackStyle(detection).fill,
          fillAlpha: 0.62,
          mode: MaskRenderMode.FillAndStroke,
          opacity: 0.9,
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
          edgeShadowStroke: { alpha: 0.5, color: 0x111827, width: 5 },
          edgeStroke: (detection) => ({
            color: getTrackStyle(detection).stroke,
            width: 2.5,
          }),
          markerFill: (detection) => ({
            color: getTrackStyle(detection).fill,
          }),
          radius: 4.5,
          shouldRender: shouldRenderObserved,
        })
      : null;
  const labelStyle = new BaseLabelStyle({
    background: (detection) => ({
      alpha: 0.92,
      color: getTrackStyle(detection).labelBackground,
    }),
    shouldRender: shouldRenderLabel,
    text: (detection) =>
      detection.trackerId === undefined
        ? undefined
        : `${detection.className ?? "object"} #${detection.trackerId}${
            detection.trackerState === DetectionTrackerState.Predicted
              ? ` · predicted +${detection.trackerAge ?? 1}f`
              : ""
          }`,
    textStyle: (detection) => ({
      color: getTrackStyle(detection).labelText,
      fontSize: 13,
    }),
  });

  return {
    backgroundColor: 0xf3f4f6,
    boxStyle,
    focusStyle: null,
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

export function createDocsTrackingSnippet(
  geometry: TrackingGeometry,
  iouThreshold: number,
  maxAge: number,
) {
  return `const pipeline = createDetectionPostProcessingPipeline({
  mutateInput: false, // Keep raw frames for this comparison playground.
  processors: [
    detectionPostProcessors.tracking({
      algorithm: "sort",
      geometry: TrackingGeometry.${geometryName(geometry)},
      iouThreshold: ${iouThreshold.toFixed(2)},
      maxAge: ${maxAge},
      emitPredictions: true,
    }),
  ],
  output: trackedSource,
});

// Safe for out-of-order SSE arrivals.
await pipeline.appendFrames([detectionFrame]);`;
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
      : Math.max(0, detection.trackerId - 1);
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
