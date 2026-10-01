import { EncodedPacketSink } from "mediabunny";

import { FRAME_TIMELINE } from "./constants";
import { FrameTimeline } from "./frame-timeline";
import { WebVideoEngineError, WebVideoEngineErrorCode } from "./types";

interface TrackWithTimeResolution {
  getTimeResolution?: () => Promise<number>;
  timeResolution?: number;
  getDurationFromMetadata?: () => Promise<number | null>;
}

/**
 * Walks the track's packets metadata-only and records each one's timestamp in
 * the container's own integer grain, which is the grain every timestamp of the
 * track is a whole multiple of.
 *
 * Decode order is not presentation order on a B-frame source, so the table is
 * sorted before it is indexed, and the trailing frame's duration comes from the
 * packet that ends up last in that order. A WebM block need not state a
 * duration, which the demuxer reads as zero, so a last frame without one is
 * given a duration from elsewhere.
 */
export async function readFrameTimeline(
  videoTrack: unknown,
): Promise<FrameTimeline> {
  return (await readFrameIndex(videoTrack)).timeline;
}

/**
 * The same walk, also naming the key frames: the presentation index of every
 * frame a decode can start at, ascending.
 */
export async function readFrameIndex(videoTrack: unknown): Promise<{
  readonly timeline: FrameTimeline;
  readonly keyIndices: Int32Array;
}> {
  const track = videoTrack as TrackWithTimeResolution;
  const tickRate =
    typeof track.getTimeResolution === "function"
      ? await track.getTimeResolution()
      : (track.timeResolution ?? FRAME_TIMELINE.FALLBACK_TICK_RATE);
  const sink = new EncodedPacketSink(
    videoTrack as ConstructorParameters<typeof EncodedPacketSink>[0],
  );
  const ticks: number[] = [];
  const keyTicks = new Set<number>();
  let lastTicks = -Infinity;
  let lastDurationTicks = 0;
  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    const at = Math.round(packet.timestamp * tickRate);
    if (ticks.length >= FRAME_TIMELINE.MAX_FRAMES) {
      throw new WebVideoEngineError(
        WebVideoEngineErrorCode.DecodeUnsupported,
        `openInput: source video track carries more than ${FRAME_TIMELINE.MAX_FRAMES} frames`,
      );
    }
    ticks.push(at);
    if (packet.type === "key") keyTicks.add(at);
    if (at >= lastTicks) {
      lastTicks = at;
      lastDurationTicks = Math.round(packet.duration * tickRate);
    }
  }
  if (ticks.length === 0) {
    throw new WebVideoEngineError(
      WebVideoEngineErrorCode.DecodeUnsupported,
      "openInput: source video track has no frames",
    );
  }
  ticks.sort((a, b) => a - b);
  if (lastDurationTicks === 0) {
    lastDurationTicks = await unstatedLastDurationTicks(track, ticks, tickRate);
  }
  const timeline = FrameTimeline.from({
    lastDurationTicks,
    tickRate,
    ticks: Float64Array.from(ticks),
  });
  const { ticks: presented, sourceTicks = presented } = timeline.toData();
  const keyIndices: number[] = [];
  for (let index = 0; index < sourceTicks.length; index += 1) {
    if (keyTicks.has(sourceTicks[index])) keyIndices.push(index);
  }
  return { keyIndices: Int32Array.from(keyIndices), timeline };
}

/**
 * How long the last frame lasts when its packet does not say: until the end
 * the container states for the track, else as long as the frame before it. A
 * lone frame with neither keeps a span of no time.
 */
async function unstatedLastDurationTicks(
  track: TrackWithTimeResolution,
  ticks: readonly number[],
  tickRate: number,
): Promise<number> {
  const lastTicks = ticks[ticks.length - 1];
  const statedEndS = await readStatedEndS(track);
  if (statedEndS !== null) {
    const toStatedEnd = Math.round(statedEndS * tickRate) - lastTicks;
    if (toStatedEnd > 0) return toStatedEnd;
  }
  let before = ticks.length - 2;
  while (before >= 0 && ticks[before] === lastTicks) before -= 1;
  return before >= 0 ? lastTicks - ticks[before] : 0;
}

async function readStatedEndS(
  track: TrackWithTimeResolution,
): Promise<number | null> {
  if (typeof track.getDurationFromMetadata !== "function") return null;
  try {
    const endS = await track.getDurationFromMetadata();
    return typeof endS === "number" && Number.isFinite(endS) ? endS : null;
  } catch {
    return null;
  }
}
