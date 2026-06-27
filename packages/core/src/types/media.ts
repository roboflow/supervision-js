/**
 * Renderer-neutral metadata for one media frame.
 *
 * Platform packages decide what the frame payload is: a browser `VideoSample`,
 * an ImageBitmap, a React Native native texture handle, or a test fixture.
 * Core only needs the timeline and dimensions that detections align to.
 */
export interface MediaFrameMetadata {
  readonly mediaTime: number;
  readonly frameIndex: number | null;
  readonly width: number;
  readonly height: number;
  readonly duration: number | null;
}

/**
 * Renderer-neutral media timeline metadata.
 */
export interface MediaTimelineMetadata {
  readonly duration: number | null;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number | null;
}

/**
 * Platform-owned media frame wrapper.
 *
 * `payload` intentionally stays generic. Core must never know whether a frame
 * came from Mediabunny, native camera APIs, React Native Skia, or tests.
 */
export interface PlatformMediaFrame<TPayload = unknown> {
  readonly metadata: MediaFrameMetadata;
  readonly payload: TPayload;
}

/**
 * Minimal platform media-frame source contract for future non-web packages.
 */
export interface PlatformMediaFrameSource<TPayload = unknown> {
  getTimelineMetadata(): MediaTimelineMetadata;
  readFrameAt(mediaTime: number): Promise<PlatformMediaFrame<TPayload> | null>;
  close?(): void | Promise<void>;
}
