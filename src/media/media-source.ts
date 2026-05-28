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
}

export interface DecodedMediaSource {
  readonly input: DisposableMediaInput;
  readonly metadata: DecodedMediaSourceMetadata;
  readonly sampleSink: DecodedVideoSampleSink;
}
