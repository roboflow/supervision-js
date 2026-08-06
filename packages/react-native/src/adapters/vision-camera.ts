import {
  MediaSessionMode,
  type MediaTimelineMetadata,
  type PlatformMediaFrame,
} from "supervision-js-core";
import type { CameraFrameOutput } from "react-native-vision-camera";

import type {
  MediaFrameSource,
  MediaFrameSourceConsumer,
  MediaSessionCapabilities,
} from "../types/frame-source";

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
  readonly onFrame: (frame: TFrame) => void;
  readonly onFrameDropped?: () => void;
  readonly targetResolution: {
    readonly height: number;
    readonly width: number;
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
): CameraFrameOutput {
  if (typeof require !== "function") {
    throw new Error(
      "VisionCamera frame output is unavailable in this runtime.",
    );
  }

  type VisionCameraModule = {
    useFrameOutput(config: {
      allowDeferredStart: boolean;
      dropFramesWhileBusy: boolean;
      enablePhysicalBufferRotation: boolean;
      enablePreviewSizedOutputBuffers: boolean;
      onFrame(frame: TFrame): void;
      onFrameDropped?: () => void;
      pixelFormat: "rgb";
      targetResolution: VisionCameraFrameOutputOptions<TFrame>["targetResolution"];
    }): CameraFrameOutput;
  };
  let visionCamera: VisionCameraModule;

  try {
    // Lazy require keeps this optional peer out of the base and Node test paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    visionCamera = require("react-native-vision-camera") as VisionCameraModule;
  } catch (cause) {
    throw new Error(
      "VisionCamera frame output is unavailable in this runtime.",
      {
        cause,
      },
    );
  }

  return visionCamera.useFrameOutput({
    allowDeferredStart: false,
    dropFramesWhileBusy: true,
    enablePhysicalBufferRotation: false,
    enablePreviewSizedOutputBuffers: true,
    onFrame: options.onFrame,
    onFrameDropped: options.onFrameDropped,
    pixelFormat: "rgb",
    targetResolution: options.targetResolution,
  });
}
