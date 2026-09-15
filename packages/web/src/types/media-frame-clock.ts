/** Exact presentation timing in seconds for zero-based indexed media frames. */
export interface MediaFrameClock {
  readonly frameCount: number;
  readonly firstTimestamp: number;
  /** Exclusive end of the final frame on the media timeline, in seconds. */
  readonly endTimestamp: number;
  /** Playable span in seconds: endTimestamp minus firstTimestamp. */
  readonly duration: number;
  /** Start time of a frame in presentation order. Invalid indices throw. */
  timeAt(frameIndex: number): number;
  /** Duration of one frame, including variable-rate and final frames. */
  durationAt(frameIndex: number): number;
  /** Frame covering a finite media time, clamped at the source's ends. */
  indexAtOrBefore(mediaTime: number): number;
}
