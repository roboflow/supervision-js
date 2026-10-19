/**
 * Presentation-order frame table for a source video track.
 *
 * Container packets iterate in decode order, so B-frame reordering puts them out
 * of presentation order. Detection frame indexes must count presented frames,
 * which is what sorting by timestamp produces.
 */

const SAMPLE_QUERY_EPSILON_SECONDS = 0.001;
const DECODED_TIMESTAMP_TOLERANCE_SECONDS = 0.002;

export interface FramePacketTiming {
  readonly timestamp: number;
  readonly duration: number;
}

export interface FrameTimeTableEntry {
  readonly frameIndex: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly endTime: number;
  readonly sampleQueryTime: number;
}

export interface FrameTimeTable {
  readonly entries: readonly FrameTimeTableEntry[];
  readonly frameCount: number;
  readonly firstTimestamp: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly averagePacketRate: number;
  /**
   * Worst-case error of `round((timestamp - firstTimestamp) * frameRate)`
   * against the presentation index. Zero means detection playback can recover
   * the exact source frame from a media time at `frameRate`.
   */
  readonly frameIndexRoundTripError: number;
}

export async function buildFrameTimeTable(
  packets: AsyncIterable<FramePacketTiming>,
): Promise<FrameTimeTable> {
  const timings: FramePacketTiming[] = [];

  for await (const packet of packets) {
    timings.push({ duration: packet.duration, timestamp: packet.timestamp });
  }

  return createFrameTimeTable(timings);
}

export function createFrameTimeTable(
  packets: readonly FramePacketTiming[],
): FrameTimeTable {
  packets.forEach((packet, packetIndex) =>
    validatePacketTiming(packet, packetIndex),
  );

  if (packets.length === 0) {
    throw new Error("The source video track has no frames.");
  }

  const sorted = [...packets].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const firstTimestamp = sorted[0].timestamp;
  const lastPacket = sorted[sorted.length - 1];
  const duration = lastPacket.timestamp + lastPacket.duration - firstTimestamp;
  const frameRate = sorted.length / duration;
  const entries: FrameTimeTableEntry[] = [];
  let totalPacketDuration = 0;
  let frameIndexRoundTripError = 0;

  for (const [frameIndex, packet] of sorted.entries()) {
    const previous = sorted[frameIndex - 1];

    if (previous && packet.timestamp <= previous.timestamp) {
      throw new Error(
        `The source video track repeats a frame timestamp: frameIndex=${frameIndex}, timestamp=${packet.timestamp}.`,
      );
    }

    const nextTimestamp = sorted[frameIndex + 1]?.timestamp;

    totalPacketDuration += packet.duration;
    frameIndexRoundTripError = Math.max(
      frameIndexRoundTripError,
      Math.abs(
        Math.round((packet.timestamp - firstTimestamp) * frameRate) -
          frameIndex,
      ),
    );
    entries.push({
      duration: packet.duration,
      endTime: nextTimestamp ?? firstTimestamp + duration,
      frameIndex,
      sampleQueryTime:
        packet.timestamp +
        Math.min(packet.duration, SAMPLE_QUERY_EPSILON_SECONDS),
      timestamp: packet.timestamp,
    });
  }

  return {
    averagePacketRate: sorted.length / totalPacketDuration,
    duration,
    entries,
    firstTimestamp,
    frameCount: sorted.length,
    frameIndexRoundTripError,
    frameRate,
  };
}

export function mapFrameBatch(
  table: FrameTimeTable,
  startFrameIndex: number,
  count: number,
): readonly FrameTimeTableEntry[] {
  if (!Number.isInteger(startFrameIndex) || startFrameIndex < 0) {
    throw new Error("startFrameIndex must be a non-negative integer.");
  }

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("count must be a positive integer.");
  }

  const endFrameIndex = startFrameIndex + count;

  if (endFrameIndex > table.frameCount) {
    throw new Error(
      `Requested frames past the end of the source frame table: startFrameIndex=${startFrameIndex}, count=${count}, frameCount=${table.frameCount}.`,
    );
  }

  return table.entries.slice(startFrameIndex, endFrameIndex);
}

export function assertDecodedFrameTimestamp(
  entry: FrameTimeTableEntry,
  decodedTimestamp: number,
): void {
  if (
    Math.abs(decodedTimestamp - entry.timestamp) >
    DECODED_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    throw new Error(
      `Decoded frame timestamp drifted from the source frame table: frameIndex=${entry.frameIndex}, expected=${entry.timestamp}, decoded=${decodedTimestamp}, tolerance=${DECODED_TIMESTAMP_TOLERANCE_SECONDS}.`,
    );
  }
}

function validatePacketTiming(packet: FramePacketTiming, packetIndex: number) {
  if (!Number.isFinite(packet.timestamp)) {
    throw new Error(
      `The source video track has a packet without a timestamp at decode position ${packetIndex}.`,
    );
  }

  if (!Number.isFinite(packet.duration) || packet.duration < 0) {
    throw new Error(
      `The source video track has a packet without a duration at decode position ${packetIndex}.`,
    );
  }
}
