import { createMediaFrameClock } from "#media/media-frame-clock";
import type { MediaFrameClock } from "#types/media-frame-clock";

/**
 * Read by the same packet walk the web video engine uses, so a depth clip
 * pairs frames on this path exactly as it does on the engine's.
 */
export async function readMediabunnyFrameClock(
  track: unknown,
): Promise<MediaFrameClock> {
  const { readFrameTimeline } = await import("#web-video-engine/frame-index");

  return createMediaFrameClock(await readFrameTimeline(track));
}
