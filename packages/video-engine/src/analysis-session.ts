import {
  type CanvasFrameSource,
  type DecodeSourceHandle,
  openDecodeSource,
  type WrappedCanvasLike,
} from "./decode-source";
import type { DecodeResolutionStrategy } from "./decode-resolution";
import { KeyframeIndex } from "./keyframe-index";
import type { ScrubTrackInfo } from "./scrub-cursor";
import type { VideoSource } from "./types";

/**
 * Playback-independent analysis over a video source: metadata, keyframe
 * discovery, and frame extraction at arbitrary timestamps. It rides the same
 * opened decode source as the playback cursor but spins no worker, binds no
 * canvas, and runs no clock, so a consumer can pull thumbnails or build a
 * contact sheet without standing up a player.
 *
 * Extracted frames are copied into their own canvases before the next decode,
 * because the underlying sink recycles a small pool round-robin; the copy is
 * what makes a returned frame safe to hold.
 */
export interface AnalysisOptions {
  source: VideoSource;
  /**
   * Output frame resolution: it sizes the decode sink, so frames decode (and
   * paint, and copy) at this width with height following native aspect. Native
   * when omitted; a capped strategy makes a thumbnail pass cheaper end to end
   * rather than decoding native and scaling down afterward.
   */
  decodeStrategy?: DecodeResolutionStrategy;
  poolSize?: number;
}

export interface AnalysisMetadata {
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
  /** Resolution extracted frames are sized to, after the decode strategy. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly nativeFps: number | null;
}

export interface ExtractedFrame {
  readonly timestampS: number;
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
}

export class AnalysisSession {
  private readonly sink: CanvasFrameSource;
  private readonly keyframeIndex: KeyframeIndex;
  private readonly track: ScrubTrackInfo;
  private readonly disposeSource: () => Promise<void>;
  private closed = false;

  constructor(source: DecodeSourceHandle) {
    this.sink = source.sink;
    this.keyframeIndex = new KeyframeIndex(source.keyframeProbe);
    this.track = source.track;
    this.disposeSource = () => source.dispose();
  }

  /** Opens a source for analysis. The returned session owns the source. */
  static async open(options: AnalysisOptions): Promise<AnalysisSession> {
    return new AnalysisSession(await openDecodeSource(options));
  }

  get metadata(): AnalysisMetadata {
    return {
      durationS: this.track.durationS,
      width: this.track.width,
      height: this.track.height,
      frameWidth: this.track.decodeWidth,
      frameHeight: this.track.decodeHeight,
      nativeFps: this.track.nativeFps,
    };
  }

  /**
   * Keyframe timestamps (seconds) whose GOP overlaps the range, resolved
   * lazily through the container. Useful for a contact sheet that lands on
   * real I-frames, which decode without a GOP walk.
   */
  keyframeTimestamps(
    startS = 0,
    endS: number = this.track.durationS,
  ): Promise<readonly number[]> {
    return this.keyframeIndex.keyframesCovering(startS, endS);
  }

  /**
   * Decodes a frame for each requested timestamp and returns a stable copy of
   * each. Timestamps are sorted so the sink decodes each packet at most once;
   * a timestamp with no frame is skipped rather than yielding a gap.
   */
  async extractFrames(
    timestampsS: readonly number[],
  ): Promise<ExtractedFrame[]> {
    const sorted = [...timestampsS].sort((a, b) => a - b);
    const frames: ExtractedFrame[] = [];
    for await (const frame of this.framesAtTimestamps(sorted)) {
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /**
   * One frame per requested timestamp, in the order asked for, `null` where no
   * frame covers it, so a caller pairing frames with its own indices keeps the
   * gaps attributable. Timestamps that climb decode in a single pass over the
   * track: one seek and GOP walk for the whole set.
   *
   * A consumer that finishes with each frame before pulling the next holds one
   * frame of memory; {@link extractFrames} holds the whole set.
   */
  async *framesAtTimestamps(
    timestampsS: readonly number[],
  ): AsyncGenerator<ExtractedFrame | null, void, unknown> {
    if (this.closed || timestampsS.length === 0) return;
    const iter = this.sink.canvasesAtTimestamps(timestampsS);
    try {
      for (
        let result = await iter.next();
        !result.done;
        result = await iter.next()
      ) {
        if (this.closed) break;
        yield result.value ? this.copyFrame(result.value) : null;
      }
    } catch (error) {
      // A concurrent close() disposes the source mid-decode; end the stream on
      // the frames already yielded rather than throwing on the teardown.
      if (!this.closed) throw error;
    } finally {
      void iter.return();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.disposeSource();
  }

  private copyFrame(frame: WrappedCanvasLike): ExtractedFrame {
    const width = this.track.decodeWidth;
    const height = this.track.decodeHeight;
    const canvas = new OffscreenCanvas(width, height);
    // Frames are opaque video; alpha:false skips per-pixel blend.
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx?.drawImage(frame.canvas, 0, 0, width, height);
    return { timestampS: frame.timestamp, canvas, width, height };
  }
}
