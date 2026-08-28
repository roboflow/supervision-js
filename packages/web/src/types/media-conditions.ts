/**
 * Where a container keeps the table that says which byte range holds which
 * frame.
 */
export enum MediaIndexPlacement {
  /** Before the media data, so an open reads it in the first bytes. */
  Front = "front",
  /** After the media data, so an open over a link seeks to the end first. */
  End = "end",
  /** One index per fragment, spread through the file. */
  Fragmented = "fragmented",
  /** Not an ISO base media file, which is the only layout this probe reads. */
  Unknown = "unknown",
}

/** A fact about a source that conversion could be a response to. */
export enum MediaConditionCode {
  /** The demuxer does not read this file's container. */
  ContainerUnreadable = "containerUnreadable",
  /** The container opened and the demuxer parsed no track out of it. */
  VideoTrackUnreadable = "videoTrackUnreadable",
  /** The container's tracks read and none of them carries video. */
  NoVideoTrack = "noVideoTrack",
  /** A video track the demuxer cannot name a codec for, so no decoder can be
   *  configured for it whatever the browser supports. */
  CodecUnnamed = "codecUnnamed",
  /** The codec is named and this browser has no decoder for it. */
  CodecUndecodable = "codecUndecodable",
  /**
   * Frames do not arrive on a steady grid: two share a presentation timestamp,
   * or the gaps between them take more values than a timebase's own rounding
   * explains. Frame indices reconstructed as `round(time * rate)` name the
   * wrong frame on such a source.
   */
  UnstableFrameTiming = "unstableFrameTiming",
  /** The frame index sits after the media data, so opening over a link pays a
   *  seek to the end of the file before the first frame. */
  IndexAtEnd = "indexAtEnd",
  /** The file carries one index per fragment rather than one for the whole. */
  IndexFragmented = "indexFragmented",
  /** The first frame's presentation timestamp is not zero, so media time and
   *  elapsed time are different numbers on this source. */
  NonZeroStart = "nonZeroStart",
}

/** What a condition stands in the way of. */
export enum MediaConditionScope {
  /** Getting a picture on screen at all. */
  Playback = "playback",
  /** Naming the frame on screen by index, which is how detections are paired. */
  FrameIndexing = "frameIndexing",
}

/** What to do about a condition. */
export enum MediaConditionResponse {
  /** Open the source as it is. */
  None = "none",
  /** Copy the coded frames into another container without re-encoding them. */
  RemuxFirst = "remuxFirst",
  /** Re-encode, and open the result once it is finished. */
  ConvertFirst = "convertFirst",
  /** Re-encode, and open the prefix as it is written. */
  ConvertProgressively = "convertProgressively",
  /** Do not open it, and say why. */
  Refuse = "refuse",
}

/** Whether a response leaves the frame sequence detections index intact. */
export enum ConversionFrameEffect {
  /** Every source frame comes out, at its own presentation time. */
  Preserved = "preserved",
  /** The output carries a different frame sequence from the source, so a
   *  detection indexed against the source names a different picture. */
  Resampled = "resampled",
}

/** What the container's own layout says, read from its box headers. */
export interface MediaContainerFacts {
  readonly indexPlacement: MediaIndexPlacement;
}

/**
 * Frame timing measured over a bounded prefix of the track's packets, in the
 * container's own integer tick grain.
 */
export interface MediaTimingFacts {
  readonly tickRate: number;
  readonly sampledPacketCount: number;
  /** True when the sample reached the end of the track rather than the cap, so
   *  the verdict covers every frame rather than a prefix. */
  readonly sampleComplete: boolean;
  /** Pairs of frames sharing one presentation timestamp. */
  readonly duplicateTimestampCount: number;
  /** How many different gaps separate neighbouring frames. A constant-rate
   *  source has one, or two where the timebase cannot state the rate exactly. */
  readonly distinctGapCount: number;
  readonly minGapTicks: number;
  readonly medianGapTicks: number;
  readonly maxGapTicks: number;
  readonly firstTimestampTicks: number;
}

/** Everything the conditions are read from. Held as data so the reasoning is
 *  pure: the probe measures a source once and passes the facts in. */
export interface MediaConditionFacts {
  /** Null when the container never opened. */
  readonly container: MediaContainerFacts | null;
  readonly trackCount: number;
  readonly videoTrackCount: number;
  /** Null on a video track the demuxer cannot name a codec for. */
  readonly codec: string | null;
  /** Null where no decoder could be asked, which is every realm without
   *  WebCodecs. Absent support is `false`, not `null`. */
  readonly canDecode: boolean | null;
  /** Null when no video track was reached. */
  readonly timing: MediaTimingFacts | null;
  /** Whether the bytes come over a link, which is what makes a trailing index
   *  cost anything. */
  readonly remote: boolean;
}

export interface MediaCondition {
  readonly code: MediaConditionCode;
  readonly scope: MediaConditionScope;
  readonly response: MediaConditionResponse;
  /** What the response does to the frame sequence. Absent where the response
   *  presents nothing, so no sequence survives to compare. */
  readonly frameEffect: ConversionFrameEffect | null;
  readonly detail: string;
}

/** How the caller intends to open whatever comes out. */
export interface MediaConditionPolicy {
  /**
   * Whether the caller can open a conversion's prefix while the rest is still
   * being written. Such a source opens only at its beginning and cannot be
   * seeked into, so this is true only where playback starts at zero.
   */
  readonly progressiveConversion?: boolean;
}

export interface MediaConditionReport {
  readonly facts: MediaConditionFacts;
  readonly conditions: readonly MediaCondition[];
  /** The strongest response among the conditions standing in the way of a
   *  picture. */
  readonly playback: MediaConditionResponse;
  /** The strongest response among the conditions standing in the way of naming
   *  the frame on screen by index. */
  readonly frameIndexing: MediaConditionResponse;
}

export interface ConversionFrameEffectReport {
  readonly effect: ConversionFrameEffect;
  /** The rate the conversion will actually be run at, after the normalization
   *  defaults are applied. */
  readonly resolvedFrameRate: number;
  readonly detail: string;
}
