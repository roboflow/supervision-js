import type { HybridObject, UInt64 } from "react-native-nitro-modules";

/**
 * One decoded, upright BGRA video frame.
 *
 * The handle retains its platform pixel buffer; `release()` must be called
 * exactly once when the frame is no longer needed (after the presented packet
 * that used it has been replaced).
 */
export interface VideoFrameHandle extends HybridObject<{
  ios: "swift";
  android: "c++";
}> {
  /**
   * Retained platform buffer address — a `CVPixelBufferRef` on iOS, an
   * API-26+ `AHardwareBuffer*` on Android. Suitable for zero-copy consumers:
   * ExecuTorch frame inference and `Skia.Image.MakeImageFromNativeBuffer`.
   *
   * Unsigned on purpose: Android arm64 heap pointers are top-byte-tagged, so
   * as a signed 64-bit value they go negative and consumers that read the
   * BigInt with `asUint64()` (ExecuTorch, Skia) reject the conversion.
   */
  readonly pointer: UInt64;
  /** Presentation timestamp in milliseconds. */
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  /** Releases the retained pixel buffer. Safe to call more than once. */
  release(): void;
}

/**
 * Experimental sequential video-file frame source (iOS/AVFoundation,
 * Android/NDK MediaCodec).
 *
 * Decodes a saved video frame-by-frame with hardware decode into upright
 * frames, prefetching a small ring ahead of the consumer so decode overlaps
 * inference. This plays the role Mediabunny adapters play in the web package:
 * a media provider that feeds the renderer-neutral pipeline.
 */
export interface VideoFrameSource extends HybridObject<{
  ios: "swift";
  android: "c++";
}> {
  /**
   * Opens the file and starts decode-ahead. Throws for missing files or
   * files without a video track.
   */
  open(filePath: string): void;
  readonly durationMs: number;
  /** Upright (display-orientation) dimensions. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly nominalFrameRate: number;
  /**
   * Returns the next decoded frame in presentation order, blocking briefly
   * while the decode-ahead ring refills, or undefined at end of stream.
   */
  copyNextFrame(): VideoFrameHandle | undefined;
  /** Stops decoding and releases the reader. Idempotent. */
  close(): void;
}
