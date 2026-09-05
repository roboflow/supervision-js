import type { PresentedFrameChannel } from "#renderers/presented-frame-channel";

export interface DecodedVideoSample {
  readonly timestamp: number;
  readonly duration: number;
  draw(
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx: number,
    dy: number,
    dWidth?: number,
    dHeight?: number,
  ): void;
  close(): void;
}

export interface DecodedVideoSampleSink {
  getSample(
    timestamp: number,
    options?: { skipLiveWait?: boolean },
  ): Promise<DecodedVideoSample | null>;
  samples(
    startTimestamp?: number,
    endTimestamp?: number,
    options?: { skipLiveWait?: boolean },
  ): AsyncGenerator<DecodedVideoSample, void, unknown>;
  /**
   * A sample per timestamp, in the order asked for, `null` where no frame
   * covers it, over a single pass across the track. Optional: a caller with a
   * whole set in hand takes this where a source offers it, and otherwise pays
   * a seek per {@link DecodedVideoSampleSink.getSample}.
   */
  samplesAtTimestamps?(
    timestamps: Iterable<number>,
    options?: { skipLiveWait?: boolean },
  ): AsyncGenerator<DecodedVideoSample | null, void, unknown>;
}

export interface DisposableMediaInput {
  dispose(): void;
}

export interface DecodedMediaSourceMetadata {
  readonly canRead: boolean;
  readonly formatName: string | null;
  readonly formatMimeType: string | null;
  readonly mimeType: string | null;
  readonly duration: number | null;
  readonly trackCount: number;
  readonly videoTrackCount: number;
  readonly audioTrackCount: number;
  readonly primaryVideoWidth: number;
  readonly primaryVideoHeight: number;
  readonly firstTimestamp: number;
  readonly estimatedFrameRate?: number | null;
  readonly estimatedFrameCount?: number | null;
}

export interface DecodedMediaSource {
  readonly input: DisposableMediaInput;
  readonly metadata: DecodedMediaSourceMetadata;
  readonly sampleSink: DecodedVideoSampleSink;
  /**
   * A source that owns its own decode clock publishes one, and the renderer
   * composites the frames it announces rather than asking `sampleSink` for a
   * frame at a time the renderer chose. `sampleSink` stays required, and still
   * serves thumbnails and one-off grabs.
   */
  readonly engine?: PresentedFrameChannel;
}
