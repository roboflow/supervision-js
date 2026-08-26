import { resolvePreparedWindowFrameCount } from "#render-preparation/prepared-render-window";
import type { RenderPreparationOptions } from "#types/render-preparation";
import { getBufferedDetectionTimelineFrameSnapshot } from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionFrame,
} from "supervision-js-core";

/** One frame of the window, and whether every enabled layer's data for it is cooked. */
export interface PreparedAnnotationWindowFrame {
  readonly frameIndex: number | null;
  readonly mediaTime: number;
  readonly prepared: boolean;
}

export interface PreparedAnnotationWindowSnapshot {
  readonly frames: readonly PreparedAnnotationWindowFrame[];
  readonly playheadMediaTime: number;
  readonly playheadPrepared: boolean;
  readonly preparedFrameCount: number;
  /** Frames ahead of the playhead the cooks aim to cover. */
  readonly spanFrameCount: number;
}

/** A layer that cooks per-frame data ahead of the playhead. */
export interface PreparedAnnotationLayer {
  isArtifactPrepared(mediaTime: number): boolean;
}

export interface PreparedAnnotationWindow {
  /**
   * The detection frame a media time may draw, or null where the timeline holds
   * none. A layer still cooking its artifact for that frame skips its own draw;
   * it does not withhold the frame from the layers with nothing to cook.
   */
  getPreparedFrame(mediaTime: number): DetectionFrame | null;
  /**
   * What a draw of a media time would find: its frame and each layer's cook. A
   * caller holding the token of what is on screen knows a redraw would change
   * it, which is how a cook that lands late reaches the screen at all.
   */
  getReadinessToken(mediaTime: number): string;
  getSnapshot(): PreparedAnnotationWindowSnapshot;
}

/**
 * Which frame a media time draws and how much of it is cooked, as two separate
 * facts. Reporting readiness is what the snapshot and the token are for; a
 * layer owing an artifact costs that layer its draw, not the whole frame.
 */
export function createPreparedAnnotationWindow(options: {
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly getLayers: () => readonly PreparedAnnotationLayer[];
  readonly getPlayheadMediaTime: () => number;
  readonly renderPreparation?: RenderPreparationOptions;
}): PreparedAnnotationWindow {
  const spanFrameCount = resolvePreparedWindowFrameCount({
    renderPreparation: options.renderPreparation,
  });

  const getPreparedFrame = (mediaTime: number) =>
    options.detectionTimeline.selectFrame(mediaTime) ?? null;

  const isFrameArtifactPrepared = (mediaTime: number) =>
    options.getLayers().every((layer) => layer.isArtifactPrepared(mediaTime));

  return {
    getPreparedFrame,

    getReadinessToken(mediaTime) {
      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);
      const cooks = options
        .getLayers()
        .map((layer) => (layer.isArtifactPrepared(mediaTime) ? "1" : "0"))
        .join("");

      return `${detectionFrame?.frameIndex ?? "time"}:${detectionFrame?.mediaTime ?? "none"}:${cooks}`;
    },

    getSnapshot() {
      const playheadMediaTime = options.getPlayheadMediaTime();
      const anchorTime =
        options.detectionTimeline.selectFrame(playheadMediaTime)?.mediaTime ??
        playheadMediaTime;
      const frames = getBufferedDetectionTimelineFrameSnapshot(
        options.detectionTimeline,
      )
        .filter((frame) => frame.mediaTime >= anchorTime)
        .slice(0, spanFrameCount)
        .map((frame) => ({
          frameIndex: frame.frameIndex ?? null,
          mediaTime: frame.mediaTime,
          prepared: isFrameArtifactPrepared(frame.mediaTime),
        }));

      return {
        frames,
        playheadMediaTime,
        playheadPrepared:
          getPreparedFrame(playheadMediaTime) !== null &&
          isFrameArtifactPrepared(playheadMediaTime),
        preparedFrameCount: frames.filter((frame) => frame.prepared).length,
        spanFrameCount,
      };
    },
  };
}
