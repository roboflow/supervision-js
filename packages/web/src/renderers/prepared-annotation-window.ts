import { resolvePreparedWindowFrameCount } from "#render-preparation/prepared-render-window";
import type { RenderPreparationOptions } from "#types/render-preparation";
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
   * The detection frame a media time may draw, or null while the window does
   * not cover that frame yet.
   */
  getPreparedFrame(mediaTime: number): DetectionFrame | null;
  /**
   * What a draw of a media time would find: its frame and each layer's cook,
   * whether or not they add up to a covered frame. A caller holding the token
   * of what is on screen knows a redraw would change it.
   */
  getReadinessToken(mediaTime: number): string;
  getSnapshot(): PreparedAnnotationWindowSnapshot;
  /**
   * The timeline the annotation layers see. It answers with a frame only where
   * the window covers it, so a layer reading it draws nothing anywhere else.
   */
  readonly preparedFrameTimeline: BufferedDetectionTimeline;
}

/**
 * Readiness as a fact about a frame: a frame the window covers has every
 * enabled layer's data cooked for it, and a frame it does not cover has nothing
 * to draw at all.
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

  const getPreparedFrame = (mediaTime: number) => {
    const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);

    if (!detectionFrame) {
      return null;
    }

    return options
      .getLayers()
      .every((layer) => layer.isArtifactPrepared(mediaTime))
      ? detectionFrame
      : null;
  };

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
      const frames = options.detectionTimeline
        .getBufferedFrames()
        .filter((frame) => frame.mediaTime >= anchorTime)
        .slice(0, spanFrameCount)
        .map((frame) => ({
          frameIndex: frame.frameIndex ?? null,
          mediaTime: frame.mediaTime,
          prepared: getPreparedFrame(frame.mediaTime) !== null,
        }));

      return {
        frames,
        playheadMediaTime,
        playheadPrepared: getPreparedFrame(playheadMediaTime) !== null,
        preparedFrameCount: frames.filter((frame) => frame.prepared).length,
        spanFrameCount,
      };
    },

    preparedFrameTimeline: {
      destroy() {
        options.detectionTimeline.destroy();
      },
      getBufferedFrames() {
        return options.detectionTimeline.getBufferedFrames();
      },
      getState() {
        return options.detectionTimeline.getState();
      },
      prefetch(mediaTime) {
        options.detectionTimeline.prefetch(mediaTime);
      },
      prepare(mediaTime, prepareOptions) {
        return options.detectionTimeline.prepare(mediaTime, prepareOptions);
      },
      selectFrame(mediaTime) {
        return getPreparedFrame(mediaTime) ?? undefined;
      },
      setTimelineContext(context) {
        options.detectionTimeline.setTimelineContext?.(context);
      },
    },
  };
}
