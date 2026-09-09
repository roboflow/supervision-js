import {
  AnalysisSession,
  type AnalysisOptions,
  type ExtractedFrame,
} from "./analysis-session";

/**
 * A second consumer of the runtime, built only on AnalysisSession's public
 * surface, with no reach into the cursor, cache, worker, or render loop. Its
 * existence is the proof that the analysis primitive is reusable: a thumbnail
 * strip or contact sheet is just a choice of which timestamps to pull, and the
 * open/close pair shows the full source lifecycle is reachable from the public
 * API alone.
 */
export class FrameExtractor {
  constructor(private readonly session: AnalysisSession) {}

  /** Opens a source and returns an extractor that owns it; close() disposes it. */
  static async open(options: AnalysisOptions): Promise<FrameExtractor> {
    return new FrameExtractor(await AnalysisSession.open(options));
  }

  /** Frames at exactly the given timestamps (seconds). */
  extractAt(timestampsS: readonly number[]): Promise<ExtractedFrame[]> {
    return this.session.extractFrames(timestampsS);
  }

  /**
   * `count` frames evenly spaced across the source, each sampled at the
   * middle of its slice so neither the first black frame nor the exact end
   * dominates the strip.
   */
  evenlySpaced(count: number): Promise<ExtractedFrame[]> {
    const { durationS } = this.session.metadata;
    if (count <= 0 || durationS <= 0) return Promise.resolve([]);
    const step = durationS / count;
    const times = Array.from({ length: count }, (_, i) => i * step + step / 2);
    return this.session.extractFrames(times);
  }

  /** One frame per keyframe in the range: a contact sheet that decodes cheaply. */
  async atKeyframes(startS?: number, endS?: number): Promise<ExtractedFrame[]> {
    const keyframes = await this.session.keyframeTimestamps(startS, endS);
    return this.session.extractFrames(keyframes);
  }

  /** Disposes the underlying analysis session. */
  close(): Promise<void> {
    return this.session.close();
  }
}
