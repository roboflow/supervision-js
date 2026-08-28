import { evaluateMediaConditions } from "#media/media-conditions";
import {
  MediaIndexPlacement,
  type MediaConditionFacts,
  type MediaConditionPolicy,
  type MediaConditionReport,
  type MediaTimingFacts,
} from "#types/media-conditions";

/** Bytes at `[start, end)`, however the caller gets them. */
export type MediaByteReader = (
  start: number,
  end: number,
) => Promise<Uint8Array>;

export interface MediaConditionProbeOptions extends MediaConditionPolicy {
  /**
   * How many packets of the track to measure timing over. The walk reads
   * metadata only: on an ISO base media file the sample table is already in
   * memory once the file opens, so raising this costs processing rather than
   * bytes; on Matroska and MPEG-TS there is no such table and every packet
   * costs a read of the media data itself.
   */
  readonly samplePackets?: number;
  /**
   * Whether the bytes stand for a file that will be opened over a link. It is
   * what makes a trailing index cost anything, and a probe run against a
   * downloaded copy of a remote file has to be told.
   */
  readonly remote?: boolean;
}

const DEFAULT_SAMPLE_PACKETS = 240;
/** Enough for a 64-bit box header, which is the longest one this walk reads. */
const BOX_HEADER_BYTES = 16;
const BOX_HEADER_MINIMUM_BYTES = 8;
const LARGE_SIZE_MARKER = 1;
/** A file whose top-level boxes have not resolved the question by here is not
 *  laid out in a way this walk describes. */
const MAX_TOP_LEVEL_BOXES = 12;

/**
 * Measures a source once and says which conversion conditions hold.
 *
 * Deliberately cheap, because "convert only when necessary" is worth nothing if
 * finding out costs what converting would. Nothing here decodes a frame or
 * reads a byte of media data on an indexed container: the container's own box
 * headers answer where the index sits, and the packet walk runs metadata-only
 * over a bounded prefix.
 */
export async function probeMediaConditions(
  source: Blob,
  options: MediaConditionProbeOptions = {},
): Promise<MediaConditionReport> {
  const { ALL_FORMATS, BlobSource, Input, UnsupportedInputFormatError } =
    await import("mediabunny");
  const indexPlacement = await readIndexPlacement(
    (start, end) => source.slice(start, end).arrayBuffer().then(toBytes),
    source.size,
  );
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });

  try {
    const facts = await collectFacts({
      indexPlacement,
      input,
      remote: options.remote === true,
      samplePackets: options.samplePackets ?? DEFAULT_SAMPLE_PACKETS,
      UnsupportedInputFormatError,
    });

    return evaluateMediaConditions(facts, options);
  } finally {
    input.dispose();
  }
}

/**
 * Where an ISO base media file keeps its frame index, read from the top-level
 * box headers alone.
 *
 * Each header states the size of its own box, so the walk hops from one to the
 * next and never reads a box's contents: eight to sixteen bytes per box, and no
 * more boxes than it takes to see `moov` or `moof`. Over a link that is a
 * handful of range requests whatever the file weighs.
 */
export async function readIndexPlacement(
  read: MediaByteReader,
  size: number,
): Promise<MediaIndexPlacement> {
  let offset = 0;
  let sawIndex = false;
  let sawMediaData = false;

  for (let box = 0; box < MAX_TOP_LEVEL_BOXES; box += 1) {
    const end = Math.min(offset + BOX_HEADER_BYTES, size);

    if (end - offset < BOX_HEADER_MINIMUM_BYTES) {
      return MediaIndexPlacement.Unknown;
    }

    const header = await read(offset, end);

    if (header.byteLength < BOX_HEADER_MINIMUM_BYTES) {
      return MediaIndexPlacement.Unknown;
    }

    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const type = boxType(header);

    if (box === 0 && type !== "ftyp") {
      return MediaIndexPlacement.Unknown;
    }

    if (type === "moof") {
      return MediaIndexPlacement.Fragmented;
    }

    if (type === "moov") {
      if (sawMediaData) {
        return MediaIndexPlacement.End;
      }

      // A fragmented file opens on an index too, and only the fragment header
      // that follows it tells the two layouts apart.
      sawIndex = true;
    }

    if (type === "mdat") {
      if (sawIndex) {
        return MediaIndexPlacement.Front;
      }

      sawMediaData = true;
    }

    const boxSize = readBoxSize(view, header.byteLength);

    if (boxSize === null) {
      return MediaIndexPlacement.Unknown;
    }

    offset += boxSize;

    if (offset >= size) {
      return MediaIndexPlacement.Unknown;
    }
  }

  return MediaIndexPlacement.Unknown;
}

interface MediabunnyVideoTrack {
  canDecode(): Promise<boolean>;
  getCodec(): Promise<string | null>;
  getTimeResolution?(): Promise<number>;
  readonly timeResolution?: number;
}

interface MediabunnyInput {
  getTracks(): Promise<readonly unknown[]>;
  getPrimaryVideoTrack(): Promise<MediabunnyVideoTrack | null>;
}

async function collectFacts(options: {
  readonly indexPlacement: MediaIndexPlacement;
  readonly input: MediabunnyInput;
  readonly remote: boolean;
  readonly samplePackets: number;
  readonly UnsupportedInputFormatError: new (...args: never[]) => Error;
}): Promise<MediaConditionFacts> {
  let videoTrack: MediabunnyVideoTrack | null;

  try {
    videoTrack = await options.input.getPrimaryVideoTrack();
  } catch (error: unknown) {
    if (error instanceof options.UnsupportedInputFormatError) {
      return {
        canDecode: null,
        codec: null,
        container: null,
        remote: options.remote,
        timing: null,
        trackCount: 0,
        videoTrackCount: 0,
      };
    }

    throw error;
  }

  const tracks = await options.input.getTracks();
  const container = { indexPlacement: options.indexPlacement };

  if (!videoTrack) {
    return {
      canDecode: null,
      codec: null,
      container,
      remote: options.remote,
      timing: null,
      trackCount: tracks.length,
      videoTrackCount: 0,
    };
  }

  const [codec, canDecode] = await Promise.all([
    videoTrack.getCodec(),
    videoTrack.canDecode(),
  ]);

  return {
    canDecode,
    codec,
    container,
    remote: options.remote,
    timing: await measureTiming(videoTrack, options.samplePackets),
    trackCount: tracks.length,
    videoTrackCount: countVideoTracks(tracks),
  };
}

async function measureTiming(
  videoTrack: MediabunnyVideoTrack,
  samplePackets: number,
): Promise<MediaTimingFacts> {
  const { EncodedPacketSink } = await import("mediabunny");
  const tickRate = await readTickRate(videoTrack);
  const sink = new EncodedPacketSink(
    videoTrack as ConstructorParameters<typeof EncodedPacketSink>[0],
  );
  const decodeOrderTicks: number[] = [];
  let sampleComplete = true;

  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    decodeOrderTicks.push(Math.round(packet.timestamp * tickRate));

    if (decodeOrderTicks.length >= samplePackets) {
      sampleComplete = false;
      break;
    }
  }

  return summarizeTiming(decodeOrderTicks, tickRate, sampleComplete);
}

/**
 * Turns a walk of packet timestamps into the timing facts, in ticks.
 *
 * Decode order is not presentation order, so the table is sorted before its
 * gaps are read. A walk that stopped at the cap has read every packet up to a
 * decode position and no further, which leaves the tail of the sorted table
 * missing frames that sit between ones it did read; the deepest reordering seen
 * bounds how much of that tail is untrustworthy, and it is dropped. A walk that
 * ran to the end of the track has no such tail.
 */
export function summarizeTiming(
  decodeOrderTicks: readonly number[],
  tickRate: number,
  sampleComplete: boolean,
): MediaTimingFacts {
  const sorted = [...decodeOrderTicks].sort((first, second) => first - second);
  const usable = sampleComplete
    ? sorted
    : sorted.slice(
        0,
        Math.max(2, sorted.length - reorderDepth(sorted, decodeOrderTicks)),
      );
  const gaps: number[] = [];

  for (let index = 1; index < usable.length; index += 1) {
    gaps.push(usable[index] - usable[index - 1]);
  }

  gaps.sort((first, second) => first - second);

  return {
    distinctGapCount: new Set(gaps).size,
    duplicateTimestampCount: gaps.filter((gap) => gap === 0).length,
    firstTimestampTicks: sorted.length > 0 ? sorted[0] : 0,
    maxGapTicks: gaps.length > 0 ? gaps[gaps.length - 1] : 0,
    medianGapTicks: gaps.length > 0 ? gaps[gaps.length >> 1] : 0,
    minGapTicks: gaps.length > 0 ? gaps[0] : 0,
    sampleComplete,
    sampledPacketCount: decodeOrderTicks.length,
    tickRate,
  };
}

/** How far a packet travels between decode position and presentation position,
 *  at its furthest. */
function reorderDepth(
  sorted: readonly number[],
  decodeOrderTicks: readonly number[],
) {
  const rankByTick = new Map<number, number>();

  for (let index = 0; index < sorted.length; index += 1) {
    if (!rankByTick.has(sorted[index])) {
      rankByTick.set(sorted[index], index);
    }
  }

  let deepest = 0;

  for (let index = 0; index < decodeOrderTicks.length; index += 1) {
    const rank = rankByTick.get(decodeOrderTicks[index]) ?? index;

    deepest = Math.max(deepest, Math.abs(rank - index));
  }

  return deepest;
}

async function readTickRate(videoTrack: MediabunnyVideoTrack) {
  return typeof videoTrack.getTimeResolution === "function"
    ? await videoTrack.getTimeResolution()
    : (videoTrack.timeResolution ?? 1);
}

function countVideoTracks(tracks: readonly unknown[]) {
  return tracks.filter((track) => {
    return (track as { readonly type?: unknown }).type === "video";
  }).length;
}

function boxType(header: Uint8Array) {
  return String.fromCharCode(header[4], header[5], header[6], header[7]);
}

function readBoxSize(view: DataView, available: number) {
  const size = view.getUint32(0);

  if (size === LARGE_SIZE_MARKER) {
    return available < BOX_HEADER_BYTES
      ? null
      : Number(view.getBigUint64(BOX_HEADER_MINIMUM_BYTES));
  }

  return size < BOX_HEADER_MINIMUM_BYTES ? null : size;
}

function toBytes(buffer: ArrayBuffer) {
  return new Uint8Array(buffer);
}
