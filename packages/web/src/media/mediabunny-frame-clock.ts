import { createMediaFrameClock } from "#media/media-frame-clock";
import type { MediaFrameClock } from "#types/media-frame-clock";

/**
 * The frame index of a track Mediabunny opened, read from its packet table
 * by the walk the web video engine reads its own frames by, so a depth clip
 * pairs frames on this path exactly as it does on the engine's. Pre-roll
 * that ends at or before zero is dropped and the frame straddling zero starts
 * at zero, which is where the pull path presents it.
 */
export async function readMediabunnyFrameClock(
  track: unknown,
): Promise<MediaFrameClock> {
  const { readFrameTimeline } = await import("#web-video-engine/frame-index");

  return createMediaFrameClock(await readFrameTimeline(track));
}
