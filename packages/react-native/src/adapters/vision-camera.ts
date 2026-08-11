import {
  MediaSessionMode,
  type MediaTimelineMetadata,
  type PlatformMediaFrame,
} from "supervision-js-core";
import {
  createElement,
  Fragment,
  useCallback,
  useMemo,
  type ComponentType,
  type ReactElement,
} from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type {
  CameraFrameOutput,
  CameraDevice,
  DeviceFilter,
  Frame,
  FrameRenderer,
} from "react-native-vision-camera";

import type {
  MediaFrameSource,
  MediaFrameSourceConsumer,
  MediaSessionCapabilities,
} from "../types/frame-source";

/** VisionCamera device-ranking options accepted by `useVisionCameraDevice()`. */
export type VisionCameraDeviceFilter = DeviceFilter;

/**
 * Structural subset of a VisionCamera frame used by the source adapter.
 *
 * Keeping this type structural makes the adapter independently testable and
 * keeps VisionCamera out of the base package entrypoint.
 */
export interface VisionCameraFrame {
  readonly height: number;
  readonly timestamp: number;
  readonly width: number;
  dispose(): void;
}

export interface VisionCameraLiveSourceOptions<
  TFrame extends VisionCameraFrame,
> {
  readonly onDroppedFrame?: (frame: TFrame) => void;
  readonly timeline?: Partial<MediaTimelineMetadata>;
}

export interface VisionCameraLiveSource<
  TFrame extends VisionCameraFrame,
> extends MediaFrameSource<TFrame> {
  /**
   * Called from the VisionCamera frame-output callback. Returns `false` when
   * a prior frame is still being processed; the caller must not render it.
   */
  offerFrame(frame: TFrame): boolean;
}

export interface VisionCameraFrameOutputOptions<
  TFrame extends VisionCameraFrame,
> {
  /**
   * Processes one frame and returns whether its completed packet should be
   * presented. The adapter owns rendering and disposal after this callback
   * settles, so host worklets cannot dispose a frame before native rendering.
   */
  readonly onFrame: (frame: TFrame) => boolean;
  readonly onFrameDropped?: () => void;
  readonly targetResolution: {
    readonly height: number;
    readonly width: number;
  };
}

export interface VisionCameraFrameRendererViewProps {
  readonly renderer: FrameRenderer;
  readonly style?: StyleProp<ViewStyle>;
}

export interface VisionCameraLiveViewProps {
  readonly cameraStyle?: StyleProp<ViewStyle>;
  readonly device: CameraDevice;
  readonly frameRenderer: FrameRenderer;
  readonly frameRendererStyle?: StyleProp<ViewStyle>;
  readonly isActive: boolean;
  readonly outputs: CameraFrameOutput[];
  readonly orientationSource?: "device" | "interface";
  /** Desired optical zoom, clamped by the caller to this device's range. */
  readonly zoom?: number;
}

export interface VisionCameraFrameOutputBinding {
  readonly frameOutput: CameraFrameOutput;
  readonly frameRenderer: FrameRenderer;
}

/** Optional-peer alias for a native frame passed to a host inference producer. */
export type VisionCameraOutputFrame = Frame;

export interface VisionCameraPermissionState {
  readonly hasPermission: boolean;
  requestPermission(): Promise<boolean>;
}

export interface VisionCameraFrameSize {
  readonly height: number;
  readonly width: number;
}

/**
 * Resolves a requested zoom to the nearest zoom the selected device supports.
 * This lets a host prefer iPhone's 0.5x ultra-wide lens while still working on
 * single-lens rear cameras and front cameras that begin at 1x.
 */
export function resolveVisionCameraPreferredZoom(
  device: Pick<CameraDevice, "maxZoom" | "minZoom"> | undefined,
  requestedZoom = 0.5,
): number | undefined {
  if (
    !device ||
    !Number.isFinite(device.minZoom) ||
    !Number.isFinite(device.maxZoom) ||
    !Number.isFinite(requestedZoom)
  ) {
    return undefined;
  }

  const minimum = Math.min(device.minZoom, device.maxZoom);
  const maximum = Math.max(device.minZoom, device.maxZoom);

  return Math.max(minimum, Math.min(maximum, requestedZoom));
}

/**
 * Presents a completed frame and always releases its native buffer afterwards.
 *
 * This is exported for advanced custom VisionCamera bindings; normal React
 * consumers get the same lifecycle through `useVisionCameraFrameOutput()`.
 */
export function presentVisionCameraFrame<TFrame extends VisionCameraFrame>(
  frame: TFrame,
  frameRenderer: Pick<FrameRenderer, "renderFrame">,
  processFrame: (frame: TFrame) => boolean,
): void {
  "worklet";

  try {
    if (processFrame(frame)) {
      frameRenderer.renderFrame(frame as unknown as Frame);
    }
  } finally {
    frame.dispose();
  }
}

/**
 * Resolves the upright detection coordinate space for VisionCamera's reported
 * frame orientation. The camera buffer remains native-oriented; only semantic
 * detection coordinates are normalized here.
 */
export function resolveVisionCameraFrameSize(frame: {
  readonly height: number;
  readonly orientation: string;
  readonly width: number;
}): VisionCameraFrameSize {
  "worklet";

  if (frame.orientation === "left" || frame.orientation === "right") {
    return {
      height: frame.width,
      width: frame.height,
    };
  }

  return {
    height: frame.height,
    width: frame.width,
  };
}

/** Builds the native presentation transform that matches the camera orientation. */
export function resolveVisionCameraFrameRendererStyle(options: {
  readonly canvasHeight: number;
  readonly canvasWidth: number;
  /** Dimensions after normalizing the frame to the requested output orientation. */
  readonly mediaHeight: number;
  readonly mediaWidth: number;
  readonly orientation: string;
}): ViewStyle {
  const scale = Math.max(
    options.canvasWidth / options.mediaWidth,
    options.canvasHeight / options.mediaHeight,
  );
  const renderedWidth = options.mediaWidth * scale;
  const renderedHeight = options.mediaHeight * scale;

  // The native display layer presents the raw buffer. Portrait VisionCamera
  // frames report left/right orientation, so rotate those buffers into the
  // same normalized space used by inference. Do not rotate `down`: on the
  // iOS front camera that would apply a second 180° turn.
  if (options.orientation === "left" || options.orientation === "right") {
    return {
      height: renderedWidth,
      left: (options.canvasWidth - renderedHeight) / 2,
      position: "absolute",
      top: (options.canvasHeight - renderedWidth) / 2,
      transform: [
        { rotate: options.orientation === "left" ? "90deg" : "-90deg" },
      ],
      width: renderedHeight,
    };
  }

  return {
    height: renderedHeight,
    left: (options.canvasWidth - renderedWidth) / 2,
    position: "absolute",
    top: (options.canvasHeight - renderedHeight) / 2,
    width: renderedWidth,
  };
}

const LIVE_CAPABILITIES: MediaSessionCapabilities = {
  live: true,
  pausable: false,
  seekable: false,
  stoppable: true,
};

/**
 * Creates the package-owned strict-sync bridge for VisionCamera frame output.
 *
 * A camera frame is presented only after its consumer settles. While that
 * happens, later frames are dropped and disposed immediately instead of
 * accumulating a native-buffer queue. The session owns processing and
 * rendering; the host only injects its camera callback and inference producer.
 */
export function createVisionCameraLiveSource<TFrame extends VisionCameraFrame>(
  options: VisionCameraLiveSourceOptions<TFrame> = {},
): VisionCameraLiveSource<TFrame> {
  let consumer: MediaFrameSourceConsumer<TFrame> | null = null;
  let destroyed = false;
  let processing = false;
  let stopped = false;
  let nextFrameIndex = 0;
  const timeline: MediaTimelineMetadata = {
    duration: null,
    frameRate: options.timeline?.frameRate ?? null,
    height: options.timeline?.height ?? 0,
    width: options.timeline?.width ?? 0,
  };

  return {
    capabilities: LIVE_CAPABILITIES,
    mode: MediaSessionMode.Stream,
    timeline,
    start(nextConsumer) {
      if (destroyed) {
        throw new Error("VisionCamera live source has been destroyed.");
      }

      consumer = nextConsumer;
      stopped = false;
    },
    stop() {
      stopped = true;
    },
    destroy() {
      destroyed = true;
      stopped = true;
      consumer = null;
    },
    offerFrame(frame) {
      if (!consumer || destroyed || stopped || processing) {
        options.onDroppedFrame?.(frame);
        frame.dispose();
        return false;
      }

      processing = true;
      const activeConsumer = consumer;
      const platformFrame: PlatformMediaFrame<TFrame> = {
        metadata: {
          duration: null,
          frameIndex: nextFrameIndex,
          height: frame.height,
          mediaTime: frame.timestamp / 1_000_000_000,
          width: frame.width,
        },
        payload: frame,
      };
      nextFrameIndex += 1;

      void Promise.resolve(activeConsumer.onFrame(platformFrame))
        .then(
          () => undefined,
          (error: unknown) => activeConsumer.onError(error),
        )
        .finally(() => {
          processing = false;
          frame.dispose();
        });
      return true;
    },
  };
}

/**
 * Package-owned VisionCamera configuration for strict-sync live processing.
 * The injected callback remains a host worklet producer; the package owns the
 * vendor hook and the non-negotiable queue policy.
 */
export function useVisionCameraFrameOutput<TFrame extends VisionCameraFrame>(
  options: VisionCameraFrameOutputOptions<TFrame>,
): VisionCameraFrameOutputBinding {
  let visionCamera: VisionCameraModule;

  try {
    visionCamera = loadVisionCamera();
  } catch (cause) {
    throw new Error(
      "VisionCamera frame output is unavailable in this runtime.",
      {
        cause,
      },
    );
  }

  const frameRenderer = useVisionCameraFrameRenderer();
  const targetResolution = useMemo(
    () => ({
      height: options.targetResolution.height,
      width: options.targetResolution.width,
    }),
    [options.targetResolution.height, options.targetResolution.width],
  );
  const onFrame = useCallback(
    (frame: Frame) => {
      "worklet";

      presentVisionCameraFrame(frame, frameRenderer, (nextFrame) =>
        options.onFrame(nextFrame as unknown as TFrame),
      );
    },
    [frameRenderer, options.onFrame],
  );

  return {
    frameOutput: visionCamera.useFrameOutput({
      allowDeferredStart: false,
      dropFramesWhileBusy: true,
      // NativeFrameRendererView presents frame pixels directly and does not
      // apply Frame.orientation metadata. Rotate here so the rendered camera,
      // inference input, and Skia overlays share one upright portrait buffer.
      enablePhysicalBufferRotation: true,
      enablePreviewSizedOutputBuffers: true,
      onFrame,
      onFrameDropped: options.onFrameDropped,
      pixelFormat: "rgb",
      targetResolution,
    }),
    frameRenderer,
  };
}

/** Returns the optional VisionCamera native frame renderer with a stable error. */
export function useVisionCameraFrameRenderer(): FrameRenderer {
  const visionCamera = loadVisionCamera();

  return visionCamera.useFrameRenderer();
}

/** Returns the optional VisionCamera device hook through the package boundary. */
export function useVisionCameraDevice(
  position: "back" | "front" | "external" | "unspecified",
  filter?: DeviceFilter,
): CameraDevice | undefined {
  const visionCamera = loadVisionCamera();

  return visionCamera.useCameraDevice(position, filter);
}

/** Returns the optional VisionCamera permission hook through the package boundary. */
export function useVisionCameraPermission(): VisionCameraPermissionState {
  const visionCamera = loadVisionCamera();

  return visionCamera.useCameraPermission();
}

/** Package-owned view binding for a VisionCamera native frame renderer. */
export function VisionCameraFrameRendererView(
  props: VisionCameraFrameRendererViewProps,
): ReactElement {
  const visionCamera = loadVisionCamera();

  return createElement(visionCamera.NativeFrameRendererView, props);
}

/**
 * Package-owned VisionCamera scene binding for the live preview and its
 * strict-sync rendered surface. Hosts supply session/producer state only;
 * the optional adapter owns the vendor component composition.
 */
export function VisionCameraLiveView(
  props: VisionCameraLiveViewProps,
): ReactElement {
  const visionCamera = loadVisionCamera();

  return createElement(
    Fragment,
    null,
    createElement(visionCamera.Camera, {
      device: props.device,
      isActive: props.isActive,
      orientationSource: props.orientationSource,
      outputs: props.outputs,
      style: props.cameraStyle,
      zoom: props.zoom,
    }),
    createElement(visionCamera.NativeFrameRendererView, {
      renderer: props.frameRenderer,
      style: props.frameRendererStyle,
    }),
  );
}

interface VisionCameraModule {
  Camera: ComponentType<VisionCameraCameraProps>;
  NativeFrameRendererView: ComponentType<VisionCameraFrameRendererViewProps>;
  useFrameOutput(config: {
    allowDeferredStart: boolean;
    dropFramesWhileBusy: boolean;
    enablePhysicalBufferRotation: boolean;
    enablePreviewSizedOutputBuffers: boolean;
    onFrame(frame: Frame): void;
    onFrameDropped?: () => void;
    pixelFormat: "rgb";
    targetResolution: VisionCameraFrameOutputOptions<Frame>["targetResolution"];
  }): CameraFrameOutput;
  useCameraDevice(
    position: "back" | "front" | "external" | "unspecified",
    filter?: DeviceFilter,
  ): CameraDevice | undefined;
  useCameraPermission(): VisionCameraPermissionState;
  useFrameRenderer(): FrameRenderer;
}

interface VisionCameraCameraProps {
  readonly device: CameraDevice;
  readonly isActive: boolean;
  readonly orientationSource?: "device" | "interface";
  readonly outputs?: CameraFrameOutput[];
  readonly style?: StyleProp<ViewStyle>;
  readonly zoom?: number;
}

function loadVisionCamera(): VisionCameraModule {
  if (typeof require !== "function") {
    throw new Error("VisionCamera is unavailable in this runtime.");
  }

  try {
    // Lazy require keeps this optional peer out of the base and Node test paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-vision-camera") as VisionCameraModule;
  } catch (cause) {
    throw new Error("VisionCamera is unavailable in this runtime.", { cause });
  }
}
