import type { FrameTimelineData } from "supervision-js-video-engine";
import type { MediaRendererSource } from "supervision";

/**
 * The engine already publishes its frame table on the snapshot it loaded with;
 * the decoded-media seam it opens through carries an estimated frame count in
 * its place. Reading the handle as the source opens is what gets the real table
 * to the surfaces that draw positions.
 */
interface FrameTimelineProducer {
  getMetadata(): { readonly timeline?: FrameTimelineData } | null;
}

export function tapFrameTimeline(
  source: MediaRendererSource,
  onFrameTimeline: (timeline: FrameTimelineData | null) => void,
): MediaRendererSource {
  return {
    async open() {
      const opened = await source.open();

      onFrameTimeline(readFrameTimeline(opened));

      return opened;
    },
  };
}

function readFrameTimeline(opened: unknown): FrameTimelineData | null {
  if (typeof opened !== "object" || opened === null) {
    return null;
  }

  const { engine } = opened as { readonly engine?: unknown };

  if (typeof engine !== "object" || engine === null) {
    return null;
  }

  const { getMetadata } = engine as Partial<FrameTimelineProducer>;

  return typeof getMetadata === "function"
    ? ((engine as FrameTimelineProducer).getMetadata()?.timeline ?? null)
    : null;
}
