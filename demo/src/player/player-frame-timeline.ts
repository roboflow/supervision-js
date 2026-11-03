import type { MediaRendererSource } from "supervision";
import type { FrameTimelineData } from "supervision/web-video-engine";

import { tapFrameTimeline } from "../session/frame-timeline-source";

export function tapActiveFrameTimeline(
  source: MediaRendererSource,
  isActive: () => boolean,
  publish: (timeline: FrameTimelineData | null) => void,
): MediaRendererSource {
  return tapFrameTimeline(source, (timeline) => {
    if (isActive()) {
      publish(timeline);
    }
  });
}
