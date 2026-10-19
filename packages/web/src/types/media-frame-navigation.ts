/** Exact frame identity and timing after navigation has landed. */
export interface MediaFrameLanding {
  readonly index: number;
  readonly mediaTime: number;
  readonly duration: number;
}

export type MediaFrameScrubSettlement =
  | { readonly status: "landed"; readonly frame: MediaFrameLanding }
  | { readonly status: "superseded" };

export interface MediaFrameScrub {
  readonly target: MediaFrameLanding;
  readonly settled: Promise<MediaFrameScrubSettlement>;
}

/** Optional exact-frame navigation for media sources with an indexed clock. */
export interface MediaFrameNavigation {
  /** Move to a frame and resolve after that exact frame is presented. */
  moveToFrame(index: number): Promise<MediaFrameLanding>;
  /** Move to the frame covering a media time and resolve after it is presented. */
  moveToTime(seconds: number): Promise<MediaFrameLanding>;
  /** Start a frame scrub and observe whether it lands or is superseded. */
  scrubToFrame(index: number): MediaFrameScrub;
  /** Start a time scrub and observe whether it lands or is superseded. */
  scrubToTime(seconds: number): MediaFrameScrub;
}
