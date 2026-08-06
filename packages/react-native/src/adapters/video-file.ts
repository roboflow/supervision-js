import type { MediaTimelineMetadata } from "supervision-js-core";

import {
  createReactNativeVideoFrameSource,
  type ReactNativeBoxedVideoFrameSource,
  type ReactNativeVideoFrameHandle,
  type ReactNativeVideoFrameSource,
} from "../video-frame-source";

/**
 * File-backed native decoder boundary for the React Native media session.
 *
 * This adapter owns creation, opening, metadata lookup, and closing of the
 * optional Nitro `VideoFrameSource`. The worklet pump remains in the legacy
 * session for now, so the boxed source is exposed only to that package-owned
 * implementation — application code never needs to unbox a hybrid object.
 */
export interface ReactNativeVideoFileSource {
  /** Video metadata becomes available after `open()` succeeds. */
  readonly timeline: MediaTimelineMetadata;
  /** Stable only while the source is open; intended for package worklets. */
  readonly boxedSource: ReactNativeBoxedVideoFrameSource;
  close(): void;
  open(): void;
}

export interface ReactNativeVideoFileSourceOptions {
  readonly fileUri: string;
}

/**
 * Creates an unopened saved-video adapter. Opening is separate so callers can
 * report a stable construction failure and clean up transactionally.
 */
export function createReactNativeVideoFileSource(
  options: ReactNativeVideoFileSourceOptions,
): ReactNativeVideoFileSource {
  let source: ReactNativeVideoFrameSource | null = null;
  let boxedSource: ReactNativeBoxedVideoFrameSource | null = null;
  let closed = false;

  return {
    get boxedSource() {
      if (!boxedSource) {
        throw new Error("Video file source has not been opened.");
      }

      return boxedSource;
    },
    close() {
      if (!source || closed) {
        return;
      }

      closed = true;
      source.close();
    },
    open() {
      if (source) {
        throw new Error("Video file source is already open.");
      }

      const handle = createReactNativeVideoFrameSource();

      if (!handle.boxed) {
        throw new Error(
          `video file source unavailable: ${handle.fallbackReason ?? "no native video frame source"}`,
        );
      }

      boxedSource = handle.boxed;
      source = boxedSource.unbox();

      try {
        source.open(options.fileUri);
      } catch (error) {
        try {
          source.close();
        } catch {
          // Preserve the useful native open failure below.
        }

        source = null;
        boxedSource = null;
        throw error;
      }
    },
    get timeline() {
      return source
        ? {
            duration: source.durationMs / 1000,
            frameRate: source.nominalFrameRate,
            height: source.frameHeight,
            width: source.frameWidth,
          }
        : EMPTY_VIDEO_TIMELINE;
    },
  };
}

const EMPTY_VIDEO_TIMELINE: MediaTimelineMetadata = {
  duration: null,
  frameRate: null,
  height: 0,
  width: 0,
};

/** Internal payload alias used by the saved-video session adapter. */
export type ReactNativeVideoFileFrame = ReactNativeVideoFrameHandle;
