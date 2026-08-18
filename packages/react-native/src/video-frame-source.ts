import type {
  VideoFrameHandle,
  VideoFrameSource,
} from "./specs/VideoFrameSource.nitro";

export const REACT_NATIVE_VIDEO_FRAME_SOURCE_NAME = "VideoFrameSource";

type NitroModulesModule = typeof import("react-native-nitro-modules");

/**
 * Minimal structural view of the Nitro `VideoFrameHandle` hybrid object.
 * Keeping this local means package consumers and tests never need
 * `react-native-nitro-modules` types; the real hybrid object satisfies it.
 */
export interface ReactNativeVideoFrameHandle {
  readonly pointer: bigint;
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  release(): void;
}

/**
 * Minimal structural view of the Nitro `VideoFrameSource` hybrid object.
 */
export interface ReactNativeVideoFrameSource {
  open(filePath: string): void;
  readonly durationMs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly nominalFrameRate: number;
  copyNextFrame(): ReactNativeVideoFrameHandle | undefined;
  close(): void;
}

/**
 * Boxed source that can cross into worklet runtimes. Mirrors Nitro's
 * `BoxedHybridObject<T>` shape without importing its types.
 */
export interface ReactNativeBoxedVideoFrameSource {
  unbox(): ReactNativeVideoFrameSource;
}

/**
 * Result of trying to create a native video frame source on the React/JS
 * thread. `boxed` is `null` when the native module is unavailable (Expo Go,
 * missing pod install, Android below API 26, plain Node); `fallbackReason`
 * explains why.
 */
export interface ReactNativeVideoFrameSourceHandle {
  readonly boxed: ReactNativeBoxedVideoFrameSource | null;
  readonly fallbackReason?: string;
}

/**
 * Saved-video decoding is implemented by the iOS AVFoundation hybrid and the
 * Android NDK MediaCodec/AHardwareBuffer hybrid. The Android native module
 * builds against API 26+ (AImageReader/AHardwareBuffer); hosts running below
 * that keep a stable capability reason instead of a native load failure.
 */
export function getReactNativeVideoFilePlatformAvailability(
  platform: string | undefined,
  platformVersion?: number,
) {
  if (
    platform === "android" &&
    platformVersion !== undefined &&
    platformVersion < 26
  ) {
    return {
      available: false,
      reason: "android-video-file-source-requires-api-26",
    } as const;
  }

  return { available: true } as const;
}

/**
 * Creates and boxes a fresh native video frame source.
 *
 * Must run on the normal React/JS thread (module lookup cannot happen inside
 * a worklet). Each call returns an independent source instance; open, pump,
 * and close it from a dedicated worklet runtime.
 */
export function createReactNativeVideoFrameSource(): ReactNativeVideoFrameSourceHandle {
  if (typeof require !== "function") {
    return {
      boxed: null,
      fallbackReason: "nitro-runtime-require-unavailable",
    };
  }

  const runtime = resolveReactNativePlatform();
  const availability = getReactNativeVideoFilePlatformAvailability(
    runtime?.os,
    runtime?.version,
  );

  if (!availability.available) {
    return { boxed: null, fallbackReason: availability.reason };
  }

  try {
    // Lazy require keeps react-native-nitro-modules an optional peer: Metro
    // resolves it inline on device, while Node/Vitest fall through to the
    // catch below and report the fallback reason instead of crashing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require("react-native-nitro-modules") as NitroModulesModule;
    const source = nitro.NitroModules.createHybridObject<VideoFrameSource>(
      REACT_NATIVE_VIDEO_FRAME_SOURCE_NAME,
    );

    return { boxed: nitro.NitroModules.box(source) };
  } catch (error) {
    return {
      boxed: null,
      fallbackReason: resolveCreateErrorMessage(error),
    };
  }
}

function resolveReactNativePlatform() {
  try {
    // Keep React Native optional for Node consumers and package tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reactNative = require("react-native") as {
      readonly Platform?: { readonly OS?: unknown; readonly Version?: unknown };
    };
    const platform = reactNative.Platform;

    if (typeof platform?.OS !== "string") {
      return undefined;
    }

    // Android reports a numeric API level; iOS reports a version string.
    return {
      os: platform.OS,
      version:
        typeof platform.Version === "number" ? platform.Version : undefined,
    };
  } catch {
    return undefined;
  }
}

function resolveCreateErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as { readonly message?: unknown };

    if (typeof record.message === "string") {
      return record.message;
    }
  }

  return "video-frame-source-create-error";
}

// Referenced for documentation purposes; the structural interfaces above are
// satisfied by these hybrid objects.
export type { VideoFrameHandle, VideoFrameSource };
