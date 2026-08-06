import {
  KeypointMarkerShape,
  KeypointVisibility,
  resolveDetectionClassColorStyle,
  type Detection,
  type DetectionFrame,
  type KeypointDrawInstruction,
} from "supervision-js-core";
import type { ReactNativeLiveSerializedDetection } from "../index";
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

      const rawDetections = runOnFrame(
        frame as Parameters<ExecutorchInstanceSegmentationRunner>[0],
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
          bbox: detection.bbox,
          color: resolveDetectionClassColorStyle(label).fill,
          label,
          mask: detection.mask,
          maskHeight: detection.maskHeight,
          maskWidth: detection.maskWidth,
          score: detection.score,
        };
      }

      return serialized;
    },
  };
}

export interface ExecutorchLivePoseProcessorOptions<TRunOnFrame = unknown> {
  readonly className?: string;
  readonly detectionThreshold?: number;
  readonly inputSize?: number;
  readonly keypointThreshold?: number;
  readonly minimumVisibleKeypoints?: number;
  readonly runOnFrame: TRunOnFrame | null;
}

export interface ExecutorchLivePoseProcessor {
  process(frame: { readonly timestamp: number }): DetectionFrame;
}

/** Creates a worklet-safe COCO pose processor for a live camera session. */
export function createExecutorchLivePoseProcessor<TRunOnFrame>(
  options: ExecutorchLivePoseProcessorOptions<TRunOnFrame>,
): ExecutorchLivePoseProcessor {
  const runOnFrame = options.runOnFrame as
    | ((
        frame: unknown,
        mirrorFrame: boolean,
        options: {
          detectionThreshold: number;
          inputSize: number;
          keypointThreshold: number;
        },
      ) => readonly ExecutorchCocoPose[])
    | null;
  const className = options.className;
  const detectionThreshold = options.detectionThreshold ?? 0.4;
  const inputSize = options.inputSize ?? 384;
  const keypointThreshold = options.keypointThreshold ?? 0.35;
  const minimumVisibleKeypoints = options.minimumVisibleKeypoints;

  return {
    process(frame) {
      "worklet";

      const poses =
        runOnFrame?.(frame, false, {
          detectionThreshold,
          inputSize,
          keypointThreshold,
        }) ?? [];

      return createDetectionFrameFromExecutorchCocoPoses({
        className,
        frameIndex: Math.round(frame.timestamp),
        mediaTime: frame.timestamp / 1_000_000_000,
        minimumVisibleKeypoints,
        poses,
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
 * The live camera path is unaffected: portrait camera frames report
 * `orientation: "left"`, whose output mapping is the identity.
 */

export interface ExecutorchBbox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface ExecutorchPosePoint {
  readonly x: number;
  readonly y: number;
}

export type ExecutorchCocoPose = Readonly<
  Record<string, ExecutorchPosePoint | undefined>
>;

export interface ExecutorchCocoPoseFrameOptions {
  readonly className?: string;
  readonly frameIndex?: number;
  readonly mediaTime?: number;
  readonly minimumVisibleKeypoints?: number;
  readonly poses: readonly ExecutorchCocoPose[];
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
      const point = pose[name];
      const isVisible =
        point !== undefined &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.y >= 0;

      visible[keypointIndex] = isVisible;

      if (isVisible && point) {
        points[keypointIndex] = { x: point.x, y: point.y };
        visibility[keypointIndex] = KeypointVisibility.Visible;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
        visibleCount += 1;
      } else {
        points[keypointIndex] = { x: 0, y: 0 };
        visibility[keypointIndex] = KeypointVisibility.NotLabeled;
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

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

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

/**
 * Resolves pose detections into renderer-neutral keypoint draw instructions.
 * This is worklet-safe so live producers never need to recreate Skia-oriented
 * pose geometry in an application callback.
 */
export function createExecutorchPoseKeypointInstructions(
  frame: DetectionFrame,
): KeypointDrawInstruction[] {
  "worklet";

  const instructions: KeypointDrawInstruction[] = [];

  for (
    let detectionIndex = 0;
    detectionIndex < frame.detections.length;
    detectionIndex += 1
  ) {
    const detection = frame.detections[detectionIndex]!;
    const geometry = detection.keypoints;

    if (!geometry) {
      continue;
    }

    const color = resolveDetectionClassColorStyle(detection.className).fill;
    const edges = geometry.edges.map(([fromIndex, toIndex]) => ({
      from: geometry.points[fromIndex]!,
      stroke: { alpha: 0.98, color, width: 3 },
      to: geometry.points[toIndex]!,
    }));
    const markers = geometry.points.flatMap((point, index) =>
      geometry.visibility?.[index] === KeypointVisibility.NotLabeled
        ? []
        : [
            {
              fill: { alpha: 1, color },
              index,
              point,
              radius: 5,
              shape: KeypointMarkerShape.Circle,
              stroke: { alpha: 1, color, width: 2 },
            },
          ],
    );

    instructions[instructions.length] = { edges, markers };
  }

  return instructions;
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
