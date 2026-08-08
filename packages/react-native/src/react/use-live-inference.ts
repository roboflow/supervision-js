import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  KeypointMarkerShape,
  resolveDetectionClassColorStyle,
  type DetectionFrame,
  type KeypointDrawInstruction,
  type PolygonDrawInstruction,
} from "supervision-js-core";

import {
  createDetectionFrameFromExecutorchCocoPoses,
  createExecutorchPoseKeypointInstructions,
  type ExecutorchLivePoseConfiguration,
  type ExecutorchLivePoseRunner,
  type ExecutorchLiveSegmentationProcessor,
} from "../adapters/executorch";
import {
  createInstantCvGoldenPoseBaseline,
  createInstantCvRuleVectorInstructions,
  createInstantCvRuntimeSignature,
  evaluateInstantCvRules,
  pickInstantCvObjectAtPoint,
  pickInstantCvPoseAtPoint,
  type InstantCvNormalizedPoint,
  type InstantCvPoseDetection,
  type InstantCvPosePoint,
  type InstantCvRule,
  type InstantCvRuleRuntime,
} from "../adapters/live-inference";
import {
  resolveVisionCameraFrameSize,
  type VisionCameraFrameOutputBinding,
  type VisionCameraOutputFrame,
} from "../adapters/vision-camera";
import type { ReactNativeLiveSerializedDetection } from "../index";
import {
  createReactNativeWorkletFrameDebugArgs,
  serializeDebugError,
} from "../worklet-debug";
import { useReactNativeLiveCameraBinding } from "./use-live-camera-binding";
import {
  useReactNativeLiveSkiaPresentation,
  type ReactNativeLiveSkiaPresentation,
} from "./live-frame-stage";
import { useReactNativeSharedValue } from "./worklet-bridge";
import { scheduleReactNativeOnJs } from "./worklet-scheduler";

export type ReactNativeLiveInferenceMode = "segmentation" | "pose";
export type ReactNativeLiveClassEffect = "redact" | "spotlight";
export type ReactNativeLiveClassEffects = Readonly<
  Record<string, ReactNativeLiveClassEffect>
>;

export interface ReactNativeLiveInferenceReadout {
  readonly artifactBytes: number;
  readonly artifactHeight: number;
  readonly artifactWidth: number;
  readonly droppedFrames: number;
  readonly frameIsMirrored: boolean;
  readonly framePixelFormat: string;
  readonly frameOrientation: string;
  readonly hasPresentedFrame: boolean;
  readonly height: number;
  readonly inferenceTickMs: number;
  readonly maskBuilder: string;
  readonly maskFallbackReason: string;
  readonly maskJsFallbackCount: number;
  readonly maskResolution: string;
  readonly maskCount: number;
  readonly maskFillMs: number;
  readonly maskPrepMs: number;
  readonly maskUploadMs: number;
  readonly ruleEvalMs: number;
  readonly segmentationMs: number;
  readonly serializationMs: number;
  readonly shaderActive: boolean;
  readonly syncMode: "synced";
  readonly timestamp: number;
  readonly visibleKeypointCount: number;
  readonly width: number;
}

export interface ReactNativeLiveInferenceDetection {
  readonly bbox: ReactNativeLiveSerializedDetection["bbox"];
  readonly color: number;
  readonly label: string;
  readonly score: number;
}

export interface ReactNativeLiveInferenceError {
  readonly code: string;
  readonly frameHeight: number;
  readonly framePixelFormat: string;
  readonly frameTimestamp: number;
  readonly frameWidth: number;
  readonly hasNativeBuffer: boolean;
  readonly hasPixelBuffer: boolean;
  readonly isPlanar: boolean;
  readonly message: string;
  readonly name: string;
  readonly stage: string;
}

export type ReactNativeLiveInferenceInteractionRequest =
  | {
      readonly id: number;
      readonly kind: "capture-pose";
      readonly point: InstantCvNormalizedPoint;
    }
  | {
      readonly id: number;
      readonly kind: "pick-privacy-object" | "pick-safety-zone-object";
      readonly point: InstantCvNormalizedPoint;
    };

export type ReactNativeLiveInferenceInteractionResult =
  | {
      readonly baselineAngles: readonly number[];
      readonly baselinePoints: readonly {
        readonly visible: boolean;
        readonly x: number;
        readonly y: number;
      }[];
      readonly kind: "pose";
      readonly requestId: number;
    }
  | {
      readonly kind: "object";
      readonly label: string;
      readonly requestId: number;
      readonly target: "privacy" | "safety-zone";
      readonly usedMask: boolean;
    }
  | { readonly kind: "miss"; readonly requestId: number };

export interface ReactNativeLiveInferenceExtensionOptions {
  readonly active: boolean;
  readonly privacyActive: boolean;
  readonly privacyHasClasses: boolean;
  readonly rules: readonly InstantCvRule[];
}

export interface UseReactNativeLiveInferenceOptions<TPoseRunOnFrame = unknown> {
  readonly classEffects: ReactNativeLiveClassEffects;
  readonly extension?: ReactNativeLiveInferenceExtensionOptions;
  readonly inferenceMode: ReactNativeLiveInferenceMode;
  readonly mediaRect: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly onDetections?: (
    detections: readonly ReactNativeLiveInferenceDetection[],
  ) => void;
  readonly onError?: (error: ReactNativeLiveInferenceError) => void;
  readonly onInteraction?: (
    result: ReactNativeLiveInferenceInteractionResult,
  ) => void;
  readonly onReadout?: (readout: ReactNativeLiveInferenceReadout) => void;
  readonly onRuleRuntime?: (runtime: readonly InstantCvRuleRuntime[]) => void;
  /**
   * The package-owned VisionCamera worklet captures this structural runner
   * directly. Do not wrap it in another worklet function: JSI HostFunctions
   * are not recursively serializable across isolated worklet closures.
   */
  readonly pose: ExecutorchLivePoseConfiguration<TPoseRunOnFrame> | null;
  readonly presentation?: {
    readonly fillOpacity?: number;
    readonly maskBorderWidth?: number;
    readonly mosaicCellPx?: number;
    readonly privacyContourWidth?: number;
  };
  readonly segmentationProcessor: ExecutorchLiveSegmentationProcessor | null;
  readonly showMasks: boolean;
  readonly targetResolution: {
    readonly height: number;
    readonly width: number;
  };
}

export interface ReactNativeLiveInferenceBinding {
  readonly camera: VisionCameraFrameOutputBinding;
  readonly presentation: ReactNativeLiveSkiaPresentation;
  requestInteraction(
    request: ReactNativeLiveInferenceInteractionRequest | null,
  ): void;
}

type SharedValue<TValue> = { value: TValue };

const FULL_BBOX_MASK = new Uint8Array([1]);
const NOOP_ERROR_REPORTER: (
  error: ReactNativeLiveInferenceError,
) => void = () => {};
const NOOP_INTERACTION_REPORTER: (
  result: ReactNativeLiveInferenceInteractionResult,
) => void = () => {};
const NOOP_RUNTIME_REPORTER: (
  runtime: readonly InstantCvRuleRuntime[],
) => void = () => {};
const NOOP_DETECTIONS_REPORTER: (
  detections: readonly ReactNativeLiveInferenceDetection[],
) => void = () => {};
const NOOP_READOUT_REPORTER: (
  readout: ReactNativeLiveInferenceReadout,
) => void = () => {};

const EMPTY_EXTENSION: ReactNativeLiveInferenceExtensionOptions = {
  active: false,
  privacyActive: false,
  privacyHasClasses: false,
  rules: [],
};
const EMPTY_EXTENSION_RESULT = {
  keypoints: [] as readonly KeypointDrawInstruction[],
  polygons: [] as readonly PolygonDrawInstruction[],
  ruleEvalMs: 0,
  runtime: [] as readonly InstantCvRuleRuntime[],
};

function prepareLiveInferenceMask(options: {
  readonly classEffects: ReactNativeLiveClassEffects;
  readonly detections: readonly ReactNativeLiveSerializedDetection[];
  readonly extension: ReactNativeLiveInferenceExtensionOptions;
  readonly fillOpacity: number;
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly maskBorderWidth: number;
  readonly mediaRect: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly mosaicCellPx: number;
  readonly presentation: ReactNativeLiveSkiaPresentation;
  readonly privacyContourWidth: number;
  readonly showMasks: boolean;
}) {
  "worklet";
  const startedAt = Date.now();
  const privacyPreview =
    options.extension.privacyActive && !options.extension.privacyHasClasses;
  const masks: ReactNativeLiveSerializedDetection[] = [];
  const mosaicMaskIds: number[] = [];
  const spotlightMaskIds: number[] = [];

  for (let index = 0; index < options.detections.length; index += 1) {
    const detection = options.detections[index]!;
    const effect = options.classEffects[detection.label ?? ""];

    if (!options.showMasks && effect === undefined && !privacyPreview) {
      continue;
    }

    let mask = detection;
    if (
      effect === "redact" &&
      !options.showMasks &&
      !options.extension.active
    ) {
      mask = {
        ...detection,
        mask: FULL_BBOX_MASK,
        maskHeight: 1,
        maskWidth: 1,
      };
    }
    const maskId = masks.length + 1;
    masks[masks.length] = mask;

    if (effect === "redact") {
      mosaicMaskIds[mosaicMaskIds.length] = maskId;
    } else if (effect === "spotlight") {
      spotlightMaskIds[spotlightMaskIds.length] = maskId;
    }
  }

  const shouldPrepare =
    options.showMasks ||
    mosaicMaskIds.length > 0 ||
    spotlightMaskIds.length > 0 ||
    privacyPreview;
  const frame = shouldPrepare
    ? options.presentation.prepareMask({
        borderWidth:
          options.extension.privacyActive &&
          (privacyPreview || mosaicMaskIds.length > 0)
            ? options.privacyContourWidth
            : options.maskBorderWidth,
        detections: masks,
        edgeSmoothing:
          options.showMasks || spotlightMaskIds.length > 0 ? undefined : 0,
        // Privacy's unconfigured preview is an active segmentation state, not
        // a wireframe affordance. Keep the same readable mask fill as Safety
        // Zone so people can see exactly what a later redaction will cover.
        fillOpacity: options.fillOpacity,
        frameHeight: options.frameHeight,
        frameWidth: options.frameWidth,
        mediaRect: options.mediaRect,
        mosaicCellPx: options.mosaicCellPx,
        mosaicMaskIds,
        spotlightMaskIds,
      })
    : null;

  return { frame, preparationMs: Date.now() - startedAt };
}

function reportRuntimeIfChanged(
  runtime: readonly InstantCvRuleRuntime[],
  signature: SharedValue<string>,
  reportRuntime:
    ((runtime: readonly InstantCvRuleRuntime[]) => void) | undefined,
) {
  "worklet";
  const nextSignature = createInstantCvRuntimeSignature(runtime);
  if (nextSignature !== signature.value) {
    signature.value = nextSignature;
    scheduleReactNativeOnJs(reportRuntime ?? NOOP_RUNTIME_REPORTER, runtime);
  }
}

function evaluateLiveInferenceObjectExtension(options: {
  readonly detections: readonly ReactNativeLiveSerializedDetection[];
  readonly extension: ReactNativeLiveInferenceExtensionOptions;
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly interaction: ReactNativeLiveInferenceInteractionRequest | null;
  readonly lastInteractionId: SharedValue<number>;
  readonly previousRuntime: readonly InstantCvRuleRuntime[];
  readonly reportInteraction?: (
    result: ReactNativeLiveInferenceInteractionResult,
  ) => void;
  readonly reportRuntime?: (runtime: readonly InstantCvRuleRuntime[]) => void;
  readonly runtimeSignature: SharedValue<string>;
}) {
  "worklet";
  const startedAt = Date.now();
  const objects = options.detections.map((detection) => ({
    bbox: detection.bbox,
    label: detection.label ?? "object",
    mask: detection.mask,
    maskHeight: detection.maskHeight,
    maskWidth: detection.maskWidth,
  }));
  const runtime = evaluateInstantCvRules({
    frameHeight: options.frameHeight,
    frameWidth: options.frameWidth,
    nowMs: Date.now(),
    objects,
    previous: options.previousRuntime,
    rules: options.extension.rules,
  });
  reportRuntimeIfChanged(
    runtime,
    options.runtimeSignature,
    options.reportRuntime,
  );
  const request = options.interaction;
  if (
    request &&
    request.id !== options.lastInteractionId.value &&
    (request.kind === "pick-privacy-object" ||
      request.kind === "pick-safety-zone-object")
  ) {
    options.lastInteractionId.value = request.id;
    const pick = pickInstantCvObjectAtPoint({
      detections: objects,
      frameHeight: options.frameHeight,
      frameWidth: options.frameWidth,
      point: request.point,
    });
    scheduleReactNativeOnJs(
      options.reportInteraction ?? NOOP_INTERACTION_REPORTER,
      pick
        ? {
            kind: "object",
            label: pick.label,
            requestId: request.id,
            target:
              request.kind === "pick-safety-zone-object"
                ? "safety-zone"
                : "privacy",
            usedMask: pick.usedMask,
          }
        : { kind: "miss", requestId: request.id },
    );
  }
  const vectors = createInstantCvRuleVectorInstructions({
    frameHeight: options.frameHeight,
    frameWidth: options.frameWidth,
    markerShape: KeypointMarkerShape.Circle,
    rules: options.extension.rules,
    runtime,
  });
  return {
    keypoints: vectors.keypoints,
    polygons: vectors.polygons,
    ruleEvalMs: Date.now() - startedAt,
    runtime,
  };
}

// Worklet declaration order is runtime-significant: the Babel plugin lowers
// marked function declarations to non-hoisted assignments. Keep this converter
// before evaluateLiveInferencePoseExtension so that worklet captures a function
// instead of the module-init value `undefined`.
function toInstantCvPoses(frame: DetectionFrame): InstantCvPoseDetection[] {
  "worklet";
  const poses: InstantCvPoseDetection[] = [];
  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex]!;
    const geometry = detection.keypoints;
    if (!geometry) continue;
    const points: InstantCvPosePoint[] = [];
    for (
      let pointIndex = 0;
      pointIndex < geometry.points.length;
      pointIndex += 1
    ) {
      const point = geometry.points[pointIndex]!;
      points[points.length] = {
        visible: geometry.visibility?.[pointIndex] !== 0,
        x: point.x,
        y: point.y,
      };
    }
    poses[poses.length] = { points };
  }
  return poses;
}

function evaluateLiveInferencePoseExtension(
  options: Omit<
    Parameters<typeof evaluateLiveInferenceObjectExtension>[0],
    "detections"
  >,
  detectionFrame: DetectionFrame,
) {
  "worklet";
  const startedAt = Date.now();
  const poses = toInstantCvPoses(detectionFrame);
  const runtime =
    options.extension.rules.length === 0
      ? []
      : evaluateInstantCvRules({
          frameHeight: options.frameHeight,
          frameWidth: options.frameWidth,
          nowMs: Date.now(),
          poses,
          previous: options.previousRuntime,
          rules: options.extension.rules,
        });
  if (runtime.length > 0 || options.previousRuntime.length > 0) {
    reportRuntimeIfChanged(
      runtime,
      options.runtimeSignature,
      options.reportRuntime,
    );
  }
  const request = options.interaction;
  if (
    request?.kind === "capture-pose" &&
    request.id !== options.lastInteractionId.value
  ) {
    options.lastInteractionId.value = request.id;
    const poseIndex = pickInstantCvPoseAtPoint({
      frameHeight: options.frameHeight,
      frameWidth: options.frameWidth,
      point: request.point,
      poses,
    });
    const pose = poseIndex >= 0 ? poses[poseIndex] : undefined;
    const baselineAngles = pose
      ? createInstantCvGoldenPoseBaseline(pose.points)
      : null;
    const baselinePoints: InstantCvPosePoint[] = [];
    if (pose) {
      for (
        let pointIndex = 0;
        pointIndex < pose.points.length;
        pointIndex += 1
      ) {
        const point = pose.points[pointIndex]!;
        baselinePoints[baselinePoints.length] = {
          visible: point.visible,
          x: point.x / options.frameWidth,
          y: point.y / options.frameHeight,
        };
      }
    }
    scheduleReactNativeOnJs(
      options.reportInteraction ?? NOOP_INTERACTION_REPORTER,
      pose && baselineAngles
        ? {
            baselineAngles,
            baselinePoints,
            kind: "pose",
            requestId: request.id,
          }
        : { kind: "miss", requestId: request.id },
    );
  }
  const vectors =
    options.extension.rules.length === 0
      ? EMPTY_EXTENSION_RESULT
      : createInstantCvRuleVectorInstructions({
          frameHeight: options.frameHeight,
          frameWidth: options.frameWidth,
          markerShape: "circle" as KeypointMarkerShape,
          rules: options.extension.rules,
          runtime,
        });
  return {
    keypoints: vectors.keypoints,
    polygons: vectors.polygons,
    ruleEvalMs: Date.now() - startedAt,
    runtime,
  };
}

function toOverlayDetections(
  detections: readonly ReactNativeLiveSerializedDetection[],
): ReactNativeLiveInferenceDetection[] {
  "worklet";
  return detections.map((detection) => ({
    bbox: detection.bbox,
    color: detection.color,
    label: detection.label ?? "object",
    score: detection.score ?? 0,
  }));
}

function poseDetections(
  frame: DetectionFrame,
): ReactNativeLiveInferenceDetection[] {
  "worklet";
  const detections: ReactNativeLiveInferenceDetection[] = [];
  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex]!;
    if (!detection.rect) continue;
    const rect = detection.rect;
    detections[detections.length] = {
      bbox: {
        x1: rect.x - rect.width / 2,
        x2: rect.x + rect.width / 2,
        y1: rect.y - rect.height / 2,
        y2: rect.y + rect.height / 2,
      },
      color: 0x22c55e,
      label: detection.className ?? "person",
      score: 1,
    };
  }
  return detections;
}

function updatePoseMetrics(
  metrics: ReturnType<typeof useLiveInferenceMetrics>,
  options: {
    readonly detectionCount: number;
    readonly poseMs: number;
    readonly totalMs: number;
    readonly vectorMarkerCount: number;
    readonly vectorPrepMs: number;
  },
) {
  "worklet";
  metrics.artifactBytes.value = 0;
  metrics.artifactHeight.value = 0;
  metrics.artifactWidth.value = 0;
  metrics.inferenceTickMs.value = options.totalMs;
  metrics.maskBuilder.value = "skia-vector";
  metrics.maskCount.value = options.detectionCount;
  metrics.maskFallbackReason.value = "";
  metrics.maskFillMs.value = 0;
  metrics.maskPrepMs.value = options.vectorPrepMs;
  metrics.maskUploadMs.value = 0;
  metrics.segmentationMs.value = options.poseMs;
  metrics.serializationMs.value = 0;
  metrics.shaderActive.value = false;
  metrics.visibleKeypointCount.value = options.vectorMarkerCount;
}

function updateSegmentationMetrics(
  metrics: ReturnType<typeof useLiveInferenceMetrics>,
  options: {
    readonly detectionCount: number;
    readonly prepared: ReturnType<
      ReactNativeLiveSkiaPresentation["prepareMask"]
    >;
    readonly preparationMs: number;
    readonly segmentationMs: number;
    readonly totalMs: number;
  },
) {
  "worklet";
  const prepared = options.prepared;
  metrics.artifactBytes.value = prepared?.byteLength ?? 0;
  metrics.artifactHeight.value = prepared?.height ?? 0;
  metrics.artifactWidth.value = prepared?.width ?? 0;
  metrics.inferenceTickMs.value = options.totalMs;
  metrics.maskBuilder.value = prepared?.builder ?? "none";
  metrics.maskCount.value = options.detectionCount;
  metrics.maskFallbackReason.value = prepared?.fallbackReason ?? "";
  metrics.maskFillMs.value = prepared?.fillMs ?? 0;
  metrics.maskPrepMs.value = options.preparationMs;
  metrics.maskUploadMs.value = prepared?.uploadMs ?? 0;
  metrics.segmentationMs.value = options.segmentationMs;
  metrics.serializationMs.value = 0;
  metrics.shaderActive.value = prepared !== null;
  metrics.visibleKeypointCount.value = 0;
  if (prepared?.builder === "js") metrics.maskJsFallbackCount.value += 1;
}

function reportLiveInference(
  frame: VisionCameraOutputFrame,
  frameSize: { readonly height: number; readonly width: number },
  metrics: ReturnType<typeof useLiveInferenceMetrics>,
  droppedFrames: SharedValue<number>,
  lastReportAt: SharedValue<number>,
  reportFrame: ((readout: ReactNativeLiveInferenceReadout) => void) | undefined,
  reportDetections:
    | ((detections: readonly ReactNativeLiveInferenceDetection[]) => void)
    | undefined,
  detections: readonly ReactNativeLiveInferenceDetection[],
) {
  "worklet";
  if (Date.now() - lastReportAt.value <= 250) return;
  lastReportAt.value = Date.now();
  scheduleReactNativeOnJs(
    reportDetections ?? NOOP_DETECTIONS_REPORTER,
    detections,
  );
  scheduleReactNativeOnJs(reportFrame ?? NOOP_READOUT_REPORTER, {
    artifactBytes: metrics.artifactBytes.value,
    artifactHeight: metrics.artifactHeight.value,
    artifactWidth: metrics.artifactWidth.value,
    droppedFrames: droppedFrames.value,
    frameIsMirrored: frame.isMirrored,
    frameOrientation: frame.orientation,
    framePixelFormat: frame.pixelFormat,
    hasPresentedFrame: true,
    height: frameSize.height,
    inferenceTickMs: metrics.inferenceTickMs.value,
    maskBuilder: metrics.maskBuilder.value,
    maskCount: metrics.maskCount.value,
    maskFallbackReason: metrics.maskFallbackReason.value,
    maskFillMs: metrics.maskFillMs.value,
    maskJsFallbackCount: metrics.maskJsFallbackCount.value,
    maskPrepMs: metrics.maskPrepMs.value,
    maskResolution: "original",
    maskUploadMs: metrics.maskUploadMs.value,
    ruleEvalMs: metrics.ruleEvalMs.value,
    segmentationMs: metrics.segmentationMs.value,
    serializationMs: metrics.serializationMs.value,
    shaderActive: metrics.shaderActive.value,
    syncMode: "synced",
    timestamp: frame.timestamp,
    visibleKeypointCount: metrics.visibleKeypointCount.value,
    width: frameSize.width,
  });
}

/**
 * Owns the live worklet, strict-sync packet presentation and all frame-local
 * mutable state. Consumers provide serializable configuration and receive
 * throttled semantic readouts only; they never define a camera worklet.
 */
export function useReactNativeLiveInference<TPoseRunOnFrame>(
  options: UseReactNativeLiveInferenceOptions<TPoseRunOnFrame>,
): ReactNativeLiveInferenceBinding {
  const presentation = useReactNativeLiveSkiaPresentation();
  const mediaRect = useReactNativeSharedValue(options.mediaRect);
  const inferenceMode = useReactNativeSharedValue(options.inferenceMode);
  const classEffects = useReactNativeSharedValue(options.classEffects);
  const showMasks = useReactNativeSharedValue(options.showMasks);
  const extension =
    useReactNativeSharedValue<ReactNativeLiveInferenceExtensionOptions>(
      options.extension ?? EMPTY_EXTENSION,
    );
  const interaction =
    useReactNativeSharedValue<ReactNativeLiveInferenceInteractionRequest | null>(
      null,
    );
  const lastInteractionId = useReactNativeSharedValue(0);
  const lastRuntimeSignature = useReactNativeSharedValue("");
  const lastReportAt = useReactNativeSharedValue(0);
  const lastErrorAt = useReactNativeSharedValue(0);
  const droppedFrames = useReactNativeSharedValue(0);
  const metrics = useLiveInferenceMetrics();

  useEffect(() => {
    mediaRect.value = options.mediaRect;
  }, [mediaRect, options.mediaRect]);
  useEffect(() => {
    inferenceMode.value = options.inferenceMode;
    interaction.value = null;
    presentation.clear();
  }, [inferenceMode, interaction, options.inferenceMode, presentation]);
  useEffect(() => {
    classEffects.value = options.classEffects;
  }, [classEffects, options.classEffects]);
  useEffect(() => {
    showMasks.value = options.showMasks;
  }, [options.showMasks, showMasks]);
  useEffect(() => {
    extension.value = options.extension ?? EMPTY_EXTENSION;
    interaction.value = null;
  }, [extension, interaction, options.extension]);

  const reportFrame = useLatestReporter(options.onReadout);
  const reportDetections = useLatestReporter(options.onDetections);
  const reportError = useLatestReporter(options.onError);
  const reportRuntime = useLatestReporter(options.onRuleRuntime);
  const reportInteraction = useLatestReporter(options.onInteraction);
  const segmentationProcessor = options.segmentationProcessor;
  const configuredPoseRunner = options.pose?.runOnFrame as
    ExecutorchLivePoseRunner | null | undefined;
  const poseRunner =
    typeof configuredPoseRunner === "function" ? configuredPoseRunner : null;
  const poseClassName = options.pose?.className;
  const poseDetectionThreshold = options.pose?.detectionThreshold ?? 0.4;
  const poseFramePixelsAreUpright =
    options.pose?.framePixelsAreUpright ?? false;
  const poseInputSize = options.pose?.inputSize ?? 384;
  const poseKeypointThreshold = options.pose?.keypointThreshold ?? 0.35;
  const poseMirrorFrame = options.pose?.mirrorFrame ?? false;
  const poseMinimumVisibleKeypoints = options.pose?.minimumVisibleKeypoints;
  const poseInstructionColor = resolveDetectionClassColorStyle(
    poseClassName ?? "person",
  ).fill;
  // Capture an initialized worklet function before the callback is serialized.
  // Worklets' Babel transform does not preserve normal function hoisting.
  const createPoseDetectionFrame = createDetectionFrameFromExecutorchCocoPoses;
  const createPoseInstructions = createExecutorchPoseKeypointInstructions;
  const maskBorderWidth = options.presentation?.maskBorderWidth ?? 0;
  const fillOpacity = options.presentation?.fillOpacity ?? 0.5;
  const mosaicCellPx = options.presentation?.mosaicCellPx ?? 14;
  const privacyContourWidth = options.presentation?.privacyContourWidth ?? 2;

  const onFrame = useCallback(
    (frame: VisionCameraOutputFrame) => {
      "worklet";

      let stage = "start";

      try {
        if (!presentation.isReady) {
          return false;
        }

        const frameSize = resolveVisionCameraFrameSize(frame);
        const activeExtension = extension.value;
        const startedAt = Date.now();

        if (inferenceMode.value === "pose") {
          stage = "pose-runner-check";
          if (typeof poseRunner !== "function") {
            throw new Error(
              `Pose runner is unavailable in the frame runtime (${typeof poseRunner}).`,
            );
          }

          stage = "pose-runner-call";
          const poseStartedAt = Date.now();
          const uprightFrameHeight = poseFramePixelsAreUpright
            ? frame.height
            : null;
          const poses = poseRunner(
            poseFramePixelsAreUpright
              ? {
                  getNativeBuffer: () => frame.getNativeBuffer(),
                  isMirrored: false,
                  orientation: "up",
                }
              : frame,
            poseMirrorFrame,
            {
              detectionThreshold: poseDetectionThreshold,
              inputSize: poseInputSize,
              keypointThreshold: poseKeypointThreshold,
            },
          );
          stage = "pose-result-converter-check";
          if (typeof createPoseDetectionFrame !== "function") {
            throw new Error(
              `Pose result converter is unavailable in the frame runtime (${typeof createPoseDetectionFrame}).`,
            );
          }
          stage = "pose-result-conversion";
          const detectionFrame = createPoseDetectionFrame({
            className: poseClassName,
            frameIndex: frame.timestamp,
            mediaTime: frame.timestamp / 1_000_000_000,
            minimumVisibleKeypoints: poseMinimumVisibleKeypoints,
            poses,
            uprightFrameHeight,
          });
          const poseMs = Date.now() - poseStartedAt;
          stage = "pose-extension-evaluation";
          const extensionResult = activeExtension.active
            ? evaluateLiveInferencePoseExtension(
                {
                  extension: activeExtension,
                  frameHeight: frameSize.height,
                  frameWidth: frameSize.width,
                  interaction: interaction.value,
                  lastInteractionId,
                  previousRuntime: metrics.runtime.value,
                  reportInteraction,
                  reportRuntime,
                  runtimeSignature: lastRuntimeSignature,
                },
                detectionFrame,
              )
            : EMPTY_EXTENSION_RESULT;
          stage = "pose-extension-complete";
          metrics.runtime.value = extensionResult.runtime;
          metrics.ruleEvalMs.value = extensionResult.ruleEvalMs;

          stage = "pose-instruction-converter-check";
          if (typeof createPoseInstructions !== "function") {
            throw new Error(
              `Pose instruction converter is unavailable in the frame runtime (${typeof createPoseInstructions}).`,
            );
          }
          stage = "pose-instruction-conversion";
          const poseInstructions = createPoseInstructions(
            detectionFrame,
            poseInstructionColor,
          );
          stage = "pose-prepare-vector";
          const vector = presentation.prepareVector({
            frameHeight: frameSize.height,
            frameWidth: frameSize.width,
            keypoints: [...poseInstructions, ...extensionResult.keypoints],
            mediaRect: mediaRect.value,
            polygons: extensionResult.polygons,
          });
          presentation.presentVector(vector);
          presentation.presentMask(null);
          updatePoseMetrics(metrics, {
            detectionCount: detectionFrame.detections.length,
            poseMs,
            totalMs: Date.now() - startedAt,
            vectorMarkerCount: vector?.markerCount ?? 0,
            vectorPrepMs: vector?.prepMs ?? 0,
          });
          reportLiveInference(
            frame,
            frameSize,
            metrics,
            droppedFrames,
            lastReportAt,
            reportFrame,
            reportDetections,
            poseDetections(detectionFrame),
          );
          return true;
        }

        if (
          inferenceMode.value !== "segmentation" ||
          segmentationProcessor === null
        ) {
          return false;
        }

        stage = "segmentation-run";
        const segmentationStartedAt = Date.now();
        const detections = segmentationProcessor.process(frame);
        const segmentationMs = Date.now() - segmentationStartedAt;
        const extensionResult = activeExtension.active
          ? evaluateLiveInferenceObjectExtension({
              detections,
              extension: activeExtension,
              frameHeight: frameSize.height,
              frameWidth: frameSize.width,
              interaction: interaction.value,
              lastInteractionId,
              previousRuntime: metrics.runtime.value,
              reportInteraction,
              reportRuntime,
              runtimeSignature: lastRuntimeSignature,
            })
          : EMPTY_EXTENSION_RESULT;
        metrics.runtime.value = extensionResult.runtime;
        metrics.ruleEvalMs.value = extensionResult.ruleEvalMs;

        stage = "mask-prepare";
        const prepared = prepareLiveInferenceMask({
          classEffects: classEffects.value,
          detections,
          extension: activeExtension,
          fillOpacity,
          frameHeight: frameSize.height,
          frameWidth: frameSize.width,
          maskBorderWidth,
          mediaRect: mediaRect.value,
          mosaicCellPx,
          presentation,
          privacyContourWidth,
          showMasks: showMasks.value,
        });
        presentation.presentMask(prepared.frame);
        presentation.presentVector(
          presentation.prepareVector({
            frameHeight: frameSize.height,
            frameWidth: frameSize.width,
            keypoints: extensionResult.keypoints,
            mediaRect: mediaRect.value,
            polygons: extensionResult.polygons,
          }),
        );
        updateSegmentationMetrics(metrics, {
          detectionCount: detections.length,
          prepared: prepared.frame,
          preparationMs: prepared.preparationMs,
          segmentationMs,
          totalMs: Date.now() - startedAt,
        });
        reportLiveInference(
          frame,
          frameSize,
          metrics,
          droppedFrames,
          lastReportAt,
          reportFrame,
          reportDetections,
          toOverlayDetections(detections),
        );
        return true;
      } catch (error) {
        if (Date.now() - lastErrorAt.value > 250) {
          lastErrorAt.value = Date.now();
          scheduleReactNativeOnJs(reportError ?? NOOP_ERROR_REPORTER, {
            ...createReactNativeWorkletFrameDebugArgs(stage, frame),
            ...serializeDebugError(error),
            stage,
          });
        }
        return false;
      }
    },
    [
      classEffects,
      droppedFrames,
      extension,
      fillOpacity,
      inferenceMode,
      interaction,
      lastErrorAt,
      lastInteractionId,
      lastReportAt,
      lastRuntimeSignature,
      maskBorderWidth,
      mediaRect,
      metrics,
      mosaicCellPx,
      poseClassName,
      poseDetectionThreshold,
      poseFramePixelsAreUpright,
      poseInputSize,
      poseInstructionColor,
      poseKeypointThreshold,
      poseMinimumVisibleKeypoints,
      poseMirrorFrame,
      poseRunner,
      presentation,
      privacyContourWidth,
      reportDetections,
      reportError,
      reportFrame,
      reportInteraction,
      reportRuntime,
      segmentationProcessor,
      showMasks,
    ],
  );
  const onFrameDropped = useCallback(() => {
    "worklet";
    droppedFrames.value += 1;
  }, [droppedFrames]);
  const camera = useReactNativeLiveCameraBinding<VisionCameraOutputFrame>({
    onFrame,
    onFrameDropped,
    targetResolution: options.targetResolution,
  });
  const requestInteraction = useCallback(
    (request: ReactNativeLiveInferenceInteractionRequest | null) => {
      interaction.value = request;
    },
    [interaction],
  );

  return useMemo(
    () => ({ camera, presentation, requestInteraction }),
    [camera, presentation, requestInteraction],
  );
}

function useLiveInferenceMetrics() {
  const artifactBytes = useReactNativeSharedValue(0);
  const artifactHeight = useReactNativeSharedValue(0);
  const artifactWidth = useReactNativeSharedValue(0);
  const inferenceTickMs = useReactNativeSharedValue(0);
  const maskBuilder = useReactNativeSharedValue("none");
  const maskCount = useReactNativeSharedValue(0);
  const maskFallbackReason = useReactNativeSharedValue("");
  const maskFillMs = useReactNativeSharedValue(0);
  const maskJsFallbackCount = useReactNativeSharedValue(0);
  const maskPrepMs = useReactNativeSharedValue(0);
  const maskUploadMs = useReactNativeSharedValue(0);
  const ruleEvalMs = useReactNativeSharedValue(0);
  const runtime = useReactNativeSharedValue<readonly InstantCvRuleRuntime[]>(
    [],
  );
  const segmentationMs = useReactNativeSharedValue(0);
  const serializationMs = useReactNativeSharedValue(0);
  const shaderActive = useReactNativeSharedValue(false);
  const visibleKeypointCount = useReactNativeSharedValue(0);

  return useMemo(
    () => ({
      artifactBytes,
      artifactHeight,
      artifactWidth,
      inferenceTickMs,
      maskBuilder,
      maskCount,
      maskFallbackReason,
      maskFillMs,
      maskJsFallbackCount,
      maskPrepMs,
      maskUploadMs,
      ruleEvalMs,
      runtime,
      segmentationMs,
      serializationMs,
      shaderActive,
      visibleKeypointCount,
    }),
    [
      artifactBytes,
      artifactHeight,
      artifactWidth,
      inferenceTickMs,
      maskBuilder,
      maskCount,
      maskFallbackReason,
      maskFillMs,
      maskJsFallbackCount,
      maskPrepMs,
      maskUploadMs,
      ruleEvalMs,
      runtime,
      segmentationMs,
      serializationMs,
      shaderActive,
      visibleKeypointCount,
    ],
  );
}

/** Keeps JS-thread reporters current without changing the camera worklet closure. */
function useLatestReporter<TValue>(
  reporter: ((value: TValue) => void) | undefined,
) {
  const current = useRef(reporter);
  current.current = reporter;

  return useCallback((value: TValue) => {
    current.current?.(value);
  }, []);
}
