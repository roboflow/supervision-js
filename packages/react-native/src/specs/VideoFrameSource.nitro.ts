import type { HybridObject, Int64 } from "react-native-nitro-modules";

/**
 * One decoded, upright BGRA video frame.
 *
 * Android saved-video decoding is not implemented yet. Its future Nitro C++
 * implementation will expose an API-26+ `AHardwareBuffer` rather than this
 * iOS `CVPixelBuffer` handle.
 *
 * The handle retains its `CVPixelBuffer`; `release()` must be called exactly
 * once when the frame is no longer needed (after the presented packet that
 * used it has been replaced).
 */
export interface VideoFrameHandle extends HybridObject<{ ios: "swift" }> {
  /**
   * Retained `CVPixelBufferRef` address. Suitable for zero-copy consumers:
   * ExecuTorch frame inference and `Skia.Image.MakeImageFromNativeBuffer`.
   */
  readonly pointer: Int64;
  /** Presentation timestamp in milliseconds. */
  readonly timestampMs: number;
  readonly width: number;
  readonly height: number;
  /** Releases the retained pixel buffer. Safe to call more than once. */
  release(): void;
}

/**
 * Experimental sequential video-file frame source (iOS/AVFoundation).
 *
 * Decodes a saved video frame-by-frame with hardware decode into upright
 * BGRA `CVPixelBuffer`s, prefetching a small ring ahead of the consumer so
 * decode overlaps inference. This plays the role Mediabunny adapters play in
 * the web package: a media provider that feeds the renderer-neutral pipeline.
 */
export interface VideoFrameSource extends HybridObject<{ ios: "swift" }> {
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
