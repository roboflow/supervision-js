import {
  DetectionMaskEncoding,
  KeypointVisibility,
  resolveDetectionClassColorStyle,
  type Detection,
  type DetectionFrame,
} from "supervision-js-core";
import type { ReactNativeLiveSerializedDetection } from "../index";
import type { ReactNativeLiveDetectionProducer } from "../types/live-producer";
import type { ReactNativeVideoFrameHandle } from "../video-frame-source";

/**
 * Worklet-safe structural runner shape. It deliberately does not import
 * `react-native-executorch`: hosts keep model ownership and pass their
 * hook-provided runner into this adapter.
 */
interface ExecutorchInstanceSegmentationRunner {
  (
    frame: {
      getNativeBuffer(): { pointer: bigint; release(): void };
      isMirrored: boolean;
      orientation: "up";
    },
    mirrorFrame: boolean,
    options: {
      confidenceThreshold: number;
      maxInstances: number;
      returnMaskAtOriginalResolution: boolean;
    },
  ): readonly {
    bbox: ExecutorchBbox;
    label?: string;
    mask: Uint8Array;
    maskHeight: number;
    maskWidth: number;
    score?: number;
  }[];
}

export interface ExecutorchBbox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Inverts ExecuTorch's `orientation: "up"` output mapping, converting a bbox
 * from its "portrait screen space" back into the upright frame's coordinate
 * space. `frameHeight` is the upright frame's height (the `h` in the forward
 * mapping `(x, y) -> (h - y, x)`), for frames of any dimensions.
 */
export function unrotateExecutorchUpBbox(
  bbox: ExecutorchBbox,
  frameHeight: number,
): ExecutorchBbox {
  "worklet";

  return {
    x1: bbox.y1,
    y1: frameHeight - bbox.x2,
    x2: bbox.y2,
    y2: frameHeight - bbox.x1,
  };
}

function readExecutorchFrameHeight(frame: unknown): number | null {
  "worklet";

  const height = (frame as { readonly height?: unknown }).height;
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function createExecutorchUprightFrame(frame: unknown): {
  getNativeBuffer(): { pointer: bigint; release(): void };
  isMirrored: false;
  orientation: "up";
} {
  "worklet";

  const source = frame as {
    getNativeBuffer(): { pointer: bigint; release(): void };
  };

  return {
    getNativeBuffer: () => source.getNativeBuffer(),
    isMirrored: false,
    orientation: "up",
  };
}

export interface ExecutorchVideoFrameSerializerOptions<TRunOnFrame = unknown> {
  readonly confidenceThreshold?: number;
  readonly maxInstances?: number;
  readonly returnMasksAtOriginalResolution?: boolean;
  readonly runOnFrame: TRunOnFrame | null;
}

/** Package-owned worklet passed to the saved-video session. */
export type ExecutorchVideoFrameSerializer = (
  handle: ReactNativeVideoFrameHandle,
  returnMaskAtOriginalResolution: boolean,
) => ReactNativeLiveSerializedDetection[];

/**
 * Package-owned live segmentation producer. The host owns model loading and
 * supplies only ExecuTorch's structural runner; the live session owns the
 * frame-worklet invocation and renderer handoff.
 */
export interface ExecutorchLiveSegmentationProcessorOptions<
  TRunOnFrame = unknown,
> {
  readonly confidenceThreshold?: number;
  /**
   * The frame-output provider has already physically rotated its pixels into
   * portrait. ExecuTorch still applies its camera-orientation output mapping
   * for `orientation: "up"`, so the adapter must invert that mapping before
   * handing detections to the renderer.
   */
  readonly framePixelsAreUpright?: boolean;
  readonly maxInstances?: number;
  readonly mirrorFrame?: boolean;
  readonly returnMasksAtOriginalResolution?: boolean;
  readonly runOnFrame: TRunOnFrame | null;
}

export interface ExecutorchLiveSegmentationProcessor {
  process(frame: unknown): ReactNativeLiveSerializedDetection[];
}

/** Creates a worklet-safe segmentation processor for a live camera session. */
export function createExecutorchLiveSegmentationProcessor<TRunOnFrame>(
  options: ExecutorchLiveSegmentationProcessorOptions<TRunOnFrame>,
): ExecutorchLiveSegmentationProcessor {
  const runOnFrame =
    options.runOnFrame as ExecutorchInstanceSegmentationRunner | null;
  const confidenceThreshold = options.confidenceThreshold ?? 0.45;
  const framePixelsAreUpright = options.framePixelsAreUpright ?? false;
  const maxInstances = options.maxInstances ?? 6;
  const mirrorFrame = options.mirrorFrame ?? false;
  const returnMasksAtOriginalResolution =
    options.returnMasksAtOriginalResolution ?? true;

  return {
    process(frame) {
      "worklet";

      if (runOnFrame === null) {
        return [];
      }

      const uprightFrameHeight = framePixelsAreUpright
        ? readExecutorchFrameHeight(frame)
        : null;
      const rawDetections = runOnFrame(
        framePixelsAreUpright
          ? createExecutorchUprightFrame(frame)
          : (frame as Parameters<ExecutorchInstanceSegmentationRunner>[0]),
        mirrorFrame,
        {
          confidenceThreshold,
          maxInstances,
          returnMaskAtOriginalResolution: returnMasksAtOriginalResolution,
        },
      );
      const serialized: ReactNativeLiveSerializedDetection[] = [];

      for (let index = 0; index < rawDetections.length; index += 1) {
        const detection = rawDetections[index]!;
        const label =
          typeof detection.label === "string" ? detection.label : "";

        serialized[index] = {
          bbox:
            uprightFrameHeight === null
              ? detection.bbox
              : unrotateExecutorchUpBbox(detection.bbox, uprightFrameHeight),
          color: resolveDetectionClassColorStyle(label).fill,
          label,
          mask: detection.mask,
          maskHeight: detection.maskHeight,
          maskRotatedCw: uprightFrameHeight !== null,
          maskWidth: detection.maskWidth,
          score: detection.score,
        };
      }

      return serialized;
    },
  };
}

/**
 * Live segmentation producer: the vendor-neutral form of
 * {@link createExecutorchLiveSegmentationProcessor}.
 *
 * Returns a `DetectionFrame` instead of the package's flat serialized shape,
 * so nothing downstream needs to know ExecuTorch produced it. Every quirk is
 * repaired here:
 *
 * - bboxes are un-rotated out of ExecuTorch's "portrait screen space" mapping
 *   and converted to core's center-based `Rect`;
 * - masks are published as `DenseBitmapDetectionMask` without an upright
 *   copy, carrying `rotatedCw` so the fill loops keep sampling the buffer in
 *   place;
 * - class color is deliberately absent. Core detections carry no styling;
 *   presentation resolves color from `className`.
 */
export function createExecutorchLiveSegmentationProducer<TRunOnFrame>(
  options: ExecutorchLiveSegmentationProcessorOptions<TRunOnFrame>,
): ReactNativeLiveDetectionProducer {
  const runOnFrame =
    options.runOnFrame as ExecutorchInstanceSegmentationRunner | null;
  const confidenceThreshold = options.confidenceThreshold ?? 0.45;
  const framePixelsAreUpright = options.framePixelsAreUpright ?? false;
  const maxInstances = options.maxInstances ?? 6;
  const mirrorFrame = options.mirrorFrame ?? false;
  const returnMasksAtOriginalResolution =
    options.returnMasksAtOriginalResolution ?? true;
  const toUprightFrame = createExecutorchUprightFrame;
  const getUprightFrameHeight = readExecutorchFrameHeight;
  const unrotateBbox = unrotateExecutorchUpBbox;
  const readTimestampSeconds = readExecutorchFrameTimestampSeconds;

  return {
    process(frame) {
      "worklet";

      const mediaTime = readTimestampSeconds(frame);

      if (runOnFrame === null) {
        return { detections: [], mediaTime };
      }

      const uprightFrameHeight = framePixelsAreUpright
        ? getUprightFrameHeight(frame)
        : null;
      const rawDetections = runOnFrame(
        framePixelsAreUpright
          ? toUprightFrame(frame)
          : (frame as Parameters<ExecutorchInstanceSegmentationRunner>[0]),
        mirrorFrame,
        {
          confidenceThreshold,
          maxInstances,
          returnMaskAtOriginalResolution: returnMasksAtOriginalResolution,
        },
      );
      const detections: Detection[] = [];

      for (let index = 0; index < rawDetections.length; index += 1) {
        const raw = rawDetections[index]!;
        const bbox =
          uprightFrameHeight === null
            ? raw.bbox
            : unrotateBbox(raw.bbox, uprightFrameHeight);
        // ExecuTorch rotates mask output 90° clockwise for "up" frames, so the
        // reported dims describe the rotated buffer and the logical dims swap.
        const rotatedCw = uprightFrameHeight !== null;

        detections[index] = {
          className: typeof raw.label === "string" ? raw.label : "",
          confidence: raw.score,
          mask: {
            data: raw.mask,
            // The literal, not the imported enum object: capturing an
            // enum in VisionCamera's isolated runtime is unreliable.
            encoding: "denseBitmap" as DetectionMaskEncoding.DenseBitmap,
            height: rotatedCw ? raw.maskWidth : raw.maskHeight,
            rotatedCw,
            width: rotatedCw ? raw.maskHeight : raw.maskWidth,
          },
          rect: {
            height: bbox.y2 - bbox.y1,
            width: bbox.x2 - bbox.x1,
            x: (bbox.x1 + bbox.x2) / 2,
            y: (bbox.y1 + bbox.y2) / 2,
          },
        };
      }

      return { detections, mediaTime };
    },
  };
}

/**
 * VisionCamera reports frame timestamps in nanoseconds; core detection frames
 * are on a seconds media timeline.
 */
function readExecutorchFrameTimestampSeconds(frame: unknown): number {
  "worklet";

  const timestamp = (frame as { readonly timestamp?: unknown }).timestamp;

  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp / 1_000_000_000
    : 0;
}

export interface ExecutorchLivePoseRunnerOptions {
  readonly detectionThreshold: number;
  readonly inputSize: number;
  readonly keypointThreshold: number;
}

/** Structural live-pose runner supplied by an inference-engine owner. */
export type ExecutorchLivePoseRunner = (
  frame: unknown,
  mirrorFrame: boolean,
  options: ExecutorchLivePoseRunnerOptions,
) => readonly ExecutorchCocoPose[];

/**
 * Declarative pose-producer configuration. The live inference hook consumes
 * this shape directly so its VisionCamera worklet captures the JSI runner at
 * exactly one runtime boundary.
 */
export interface ExecutorchLivePoseConfiguration<TRunOnFrame = unknown> {
  readonly className?: string;
  readonly detectionThreshold?: number;
  /** See {@link ExecutorchLiveSegmentationProcessorOptions.framePixelsAreUpright}. */
  readonly framePixelsAreUpright?: boolean;
  readonly inputSize?: number;
  readonly keypointThreshold?: number;
  /** Mirrors model coordinates to match a front-facing camera preview. */
  readonly mirrorFrame?: boolean;
  readonly minimumVisibleKeypoints?: number;
  readonly runOnFrame: TRunOnFrame | null;
}

/** @deprecated Prefer passing ExecutorchLivePoseConfiguration to the live hook. */
export type ExecutorchLivePoseProcessorOptions<TRunOnFrame = unknown> =
  ExecutorchLivePoseConfiguration<TRunOnFrame>;

export interface ExecutorchLivePoseProcessor {
  process(frame: {
    readonly height?: number;
    getNativeBuffer?(): { pointer: bigint; release(): void };
    readonly orientation?: string;
    readonly timestamp: number;
    readonly width?: number;
  }): DetectionFrame;
}

/** Creates a worklet-safe COCO pose processor for a live camera session. */
export function createExecutorchLivePoseProcessor<TRunOnFrame>(
  options: ExecutorchLivePoseProcessorOptions<TRunOnFrame>,
): ExecutorchLivePoseProcessor {
  const configuredRunOnFrame =
    options.runOnFrame as ExecutorchLivePoseRunner | null;
  // A model hook can report ready one render before its worklet runner crosses
  // into the camera runtime. Keep that short transition inert rather than
  // trying to invoke an absent runner on every camera frame.
  const runOnFrame =
    typeof configuredRunOnFrame === "function" ? configuredRunOnFrame : null;
  const className = options.className;
  const detectionThreshold = options.detectionThreshold ?? 0.4;
  const framePixelsAreUpright = options.framePixelsAreUpright ?? false;
  const inputSize = options.inputSize ?? 384;
  const keypointThreshold = options.keypointThreshold ?? 0.35;
  const mirrorFrame = options.mirrorFrame ?? false;
  const minimumVisibleKeypoints = options.minimumVisibleKeypoints;
  // Capture the initialized worklet function here. Referencing the module
  // binding from the nested frame worklet can capture `undefined` because the
  // worklets Babel transform lowers declarations to assignments.
  const createDetectionFrame = createDetectionFrameFromExecutorchCocoPoses;
  const getUprightFrameHeight = readExecutorchFrameHeight;
  const toUprightFrame = createExecutorchUprightFrame;

  return {
    process(frame) {
      "worklet";

      const uprightFrameHeight = framePixelsAreUpright
        ? getUprightFrameHeight(frame)
        : null;
      const poses =
        runOnFrame === null
          ? []
          : runOnFrame(
              framePixelsAreUpright ? toUprightFrame(frame) : frame,
              mirrorFrame,
              {
                detectionThreshold,
                inputSize,
                keypointThreshold,
              },
            );

      return createDetectionFrame({
        className,
        frameIndex: Math.round(frame.timestamp),
        mediaTime: frame.timestamp / 1_000_000_000,
        minimumVisibleKeypoints,
        poses,
        uprightFrameHeight,
      });
    },
  };
}

/**
 * Converts the host's ExecuTorch segmentation runner into the saved-video
 * session processor. Native-buffer wrapping, upright-frame coordinate repair,
 * color resolution, and serialized mask ownership stay in the package so a
 * consuming demo does not define worklets for video inference.
 */
export function createExecutorchVideoFrameSerializer<TRunOnFrame>(
  options: ExecutorchVideoFrameSerializerOptions<TRunOnFrame>,
): ExecutorchVideoFrameSerializer {
  const runOnFrame =
    options.runOnFrame as ExecutorchInstanceSegmentationRunner | null;
  const confidenceThreshold = options.confidenceThreshold ?? 0.45;
  const maxInstances = options.maxInstances ?? 6;
  const returnMasksAtOriginalResolution =
    options.returnMasksAtOriginalResolution ?? true;

  return (handle, allowOriginalResolution) => {
    "worklet";

    if (runOnFrame === null) {
      return [];
    }

    const rawDetections = runOnFrame(
      {
        getNativeBuffer: () => ({
          pointer: handle.pointer,
          // The session owns the decoded handle until Skia finishes its
          // presentation copy; ExecuTorch must not release it.
          release: () => {},
        }),
        isMirrored: false,
        orientation: "up",
      },
      false,
      {
        confidenceThreshold,
        maxInstances,
        returnMaskAtOriginalResolution:
          returnMasksAtOriginalResolution && allowOriginalResolution,
      },
    );
    const serialized: ReactNativeLiveSerializedDetection[] = [];

    for (let index = 0; index < rawDetections.length; index += 1) {
      const detection = rawDetections[index]!;
      const label = typeof detection.label === "string" ? detection.label : "";

      serialized[index] = {
        bbox: unrotateExecutorchUpBbox(detection.bbox, handle.height),
        color: resolveDetectionClassColorStyle(label).fill,
        label,
        mask: detection.mask,
        maskHeight: detection.maskHeight,
        maskRotatedCw: true,
        maskWidth: detection.maskWidth,
        score: detection.score,
      };
    }

    return serialized;
  };
}

/**
 * Live pose producer: the vendor-neutral form of
 * {@link createExecutorchLivePoseProcessor}.
 *
 * Returns the processor itself rather than wrapping it, and that is load
 * bearing. `react-native-live-rendering.md` records that a JSI runner hidden
 * inside a second processor worklet can serialize successfully while the
 * recursively captured HostFunction becomes non-callable in the isolated
 * runtime. One worklet layer over the runner is the proven depth; adding a
 * pass-through worklet here would make two.
 *
 * This works without adaptation because the pose path already returned a
 * `DetectionFrame` — the shared contract only needed a named entry point,
 * symmetric with {@link createExecutorchLiveSegmentationProducer}.
 */
export function createExecutorchLivePoseProducer<TRunOnFrame>(
  options: ExecutorchLivePoseConfiguration<TRunOnFrame>,
): ReactNativeLiveDetectionProducer {
  return createExecutorchLivePoseProcessor(options);
}

/**
 * ExecuTorch's frame orientation API is camera-centric: there is no value
 * meaning "the buffer is already screen-upright, leave inputs and outputs
 * alone". For `orientation: "up"` the model receives the buffer unrotated
 * (correct for our upright frames), but every output is then mapped into
 * "portrait screen space":
 *
 * - points/bboxes: (x, y) -> (frameHeight - y, x)
 *   (`inverseRotateBbox`/`inverseRotatePoints` in FrameTransform.cpp)
 * - masks: rotated 90° clockwise (`cv::ROTATE_90_CLOCKWISE` in
 *   `inverseRotateMat`)
 *
 * The video pipeline always feeds upright frames — the native decoder bakes
 * each file's `preferredTransform` into the decode, so portrait, landscape,
 * and upside-down recordings all come out display-upright with any
 * dimensions. That leaves exactly one deterministic output transform to
 * invert, which this module owns:
 *
 * - bboxes are un-rotated here;
 * - masks are NOT copied upright — the serialized detection carries
 *   `maskRotatedCw: true` and the ID-mask fill loops (JS and Swift) sample
 *   the rotated buffer with transposed indices.
 *
 * A camera path with native-oriented buffers can keep passing its reported
 * `orientation: "left"`, whose output mapping is the identity. A camera path
 * that physically rotates its output instead sets `framePixelsAreUpright`,
 * passing an `up` frame to ExecuTorch and applying this same repair live.
 */

export interface ExecutorchPosePoint {
  readonly x: number;
  readonly y: number;
}

export type ExecutorchCocoPose =
  | Readonly<Record<string, ExecutorchPosePoint | undefined>>
  | readonly (ExecutorchPosePoint | undefined)[];

export interface ExecutorchCocoPoseFrameOptions {
  readonly className?: string;
  readonly frameIndex?: number;
  readonly mediaTime?: number;
  readonly minimumVisibleKeypoints?: number;
  readonly poses: readonly ExecutorchCocoPose[];
  /** Inverts ExecuTorch's `orientation: "up"` point mapping when set. */
  readonly uprightFrameHeight?: number | null;
}

/** Key order emitted by react-native-executorch's YOLO26N-Pose model. */
export const EXECUTORCH_COCO_KEYPOINT_NAMES = [
  "NOSE",
  "LEFT_EYE",
  "RIGHT_EYE",
  "LEFT_EAR",
  "RIGHT_EAR",
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_ELBOW",
  "RIGHT_ELBOW",
  "LEFT_WRIST",
  "RIGHT_WRIST",
  "LEFT_HIP",
  "RIGHT_HIP",
  "LEFT_KNEE",
  "RIGHT_KNEE",
  "LEFT_ANKLE",
  "RIGHT_ANKLE",
] as const;

/** Standard COCO-17 skeleton, using zero-based indices into the list above. */
export const EXECUTORCH_COCO_SKELETON_EDGES: readonly (readonly [
  number,
  number,
])[] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [5, 6],
  [5, 7],
  [7, 9],
  [6, 8],
  [8, 10],
  [5, 11],
  [6, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
];

/**
 * Converts named COCO-17 poses into renderer-neutral detections. ExecuTorch
 * represents suppressed keypoints as `(-1, -1)`; those points are marked
 * `NotLabeled`, excluded from the bbox, and removed from skeleton edges.
 */
export function createDetectionFrameFromExecutorchCocoPoses(
  options: ExecutorchCocoPoseFrameOptions,
): DetectionFrame {
  "worklet";

  const detections: Detection[] = [];
  const minimumVisibleKeypoints = options.minimumVisibleKeypoints ?? 3;
  // Keep this hot conversion independent from imported runtime enum objects.
  // Numeric values are the stable COCO visibility contract from core.
  const notLabeledVisibility = 0 as KeypointVisibility;
  const visibleVisibility = 2 as KeypointVisibility;

  for (let poseIndex = 0; poseIndex < options.poses.length; poseIndex += 1) {
    const pose = options.poses[poseIndex]!;
    const points: { x: number; y: number }[] = [];
    const visibility: KeypointVisibility[] = [];
    const visible: boolean[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let visibleCount = 0;

    for (
      let keypointIndex = 0;
      keypointIndex < EXECUTORCH_COCO_KEYPOINT_NAMES.length;
      keypointIndex += 1
    ) {
      const name = EXECUTORCH_COCO_KEYPOINT_NAMES[keypointIndex]!;
      // PoseEstimationModule can yield named keypoints, while its minimal
      // VisionCamera runner deliberately yields the native COCO-17 array.
      // Both shapes stay supported at this boundary without asking a demo to
      // define a worklet-side mapper.
      const namedPose = pose as Readonly<
        Record<string, ExecutorchPosePoint | undefined>
      >;
      const indexedPose = pose as readonly (ExecutorchPosePoint | undefined)[];
      const namedPoint = namedPose[name];
      const indexedPoint = indexedPose[keypointIndex];
      const point = namedPoint ?? indexedPoint;
      const isVisible =
        point !== undefined &&
        typeof point.x === "number" &&
        point.x === point.x &&
        point.x !== Number.POSITIVE_INFINITY &&
        point.x !== Number.NEGATIVE_INFINITY &&
        typeof point.y === "number" &&
        point.y === point.y &&
        point.y !== Number.POSITIVE_INFINITY &&
        point.y !== Number.NEGATIVE_INFINITY &&
        point.x >= 0 &&
        point.y >= 0;

      visible[keypointIndex] = isVisible;

      if (isVisible && point) {
        // Inline ExecuTorch's inverse `orientation: "up"` mapping. Calling a
        // second worklet helper from this serialized function can surface as
        // `undefined is not a function` in VisionCamera's isolated runtime.
        points[keypointIndex] =
          options.uprightFrameHeight === undefined ||
          options.uprightFrameHeight === null
            ? { x: point.x, y: point.y }
            : {
                x: point.y,
                y: options.uprightFrameHeight - point.x,
              };
        visibility[keypointIndex] = visibleVisibility;
        const correctedPoint = points[keypointIndex]!;
        minX = correctedPoint.x < minX ? correctedPoint.x : minX;
        minY = correctedPoint.y < minY ? correctedPoint.y : minY;
        maxX = correctedPoint.x > maxX ? correctedPoint.x : maxX;
        maxY = correctedPoint.y > maxY ? correctedPoint.y : maxY;
        visibleCount += 1;
      } else {
        points[keypointIndex] = { x: 0, y: 0 };
        visibility[keypointIndex] = notLabeledVisibility;
      }
    }

    if (visibleCount < minimumVisibleKeypoints) {
      continue;
    }

    const edges: [number, number][] = [];

    for (
      let edgeIndex = 0;
      edgeIndex < EXECUTORCH_COCO_SKELETON_EDGES.length;
      edgeIndex += 1
    ) {
      const edge = EXECUTORCH_COCO_SKELETON_EDGES[edgeIndex]!;

      if (visible[edge[0]] && visible[edge[1]]) {
        edges[edges.length] = [edge[0], edge[1]];
      }
    }

    const rawWidth = maxX - minX;
    const rawHeight = maxY - minY;
    const width = rawWidth > 1 ? rawWidth : 1;
    const height = rawHeight > 1 ? rawHeight : 1;

    detections[detections.length] = {
      className: options.className ?? "person",
      id: `pose:${options.frameIndex ?? 0}:${poseIndex}`,
      keypoints: { edges, points, visibility },
      rect: {
        height,
        width,
        x: minX + width / 2,
        y: minY + height / 2,
      },
    };
  }

  return {
    detections,
    frameIndex: options.frameIndex,
    mediaTime: options.mediaTime ?? 0,
  };
}
