/**
 * An H.264 sync sample that is not an IDR frame cannot open a WebCodecs decode
 * session: Chrome rejects the chunk with "An EncodedVideoChunk was marked as
 * type key but wasn't a key frame" and emits no frames. Adding a recovery-point
 * SEI to the access unit declares it a valid entry point, which is enough for the
 * decoder to accept it and decode forward from there.
 *
 * The decoder demands an entry point for exactly one chunk, the first after
 * configure() or flush(), and putting the SEI on any other chunk misdescribes
 * the stream. KeyPacketRequirement is what tracks which chunk that is.
 */

/**
 * SEI NAL (unit type 6) carrying one recovery_point payload: recovery_frame_cnt
 * 0, so this access unit is itself the recovery point, and exact_match_flag 1,
 * so frames from here reconstruct exactly. Closed by RBSP trailing bits.
 */
const RECOVERY_POINT_SEI_NAL = Uint8Array.of(0x06, 0x06, 0x01, 0xc2, 0x80);

/** Low five bits of a NAL's first byte, the AVC unit type. */
const NAL_TYPE_MASK = 0x1f;

/**
 * An access unit delimiter has to be the first NAL of its access unit, so it is
 * the one unit the SEI goes behind rather than ahead of.
 */
const ACCESS_UNIT_DELIMITER = 9;

/** Coded slice of an IDR picture. */
const IDR_SLICE = 5;

/**
 * Scalable and multiview extension NALs. A decoder configured from an avcC
 * record decodes the base layer and reads none of them, and Chromium's key-frame
 * detector reads the opening chunk as something other than a key frame when they
 * are in it.
 */
const EXTENSION_NAL_FIRST = 20;
const EXTENSION_NAL_LAST = 31;

/** Byte of the avcC record holding lengthSizeMinusOne in its low two bits. */
const LENGTH_SIZE_MINUS_ONE_OFFSET = 4;

const LENGTH_SIZE_MINUS_ONE_MASK = 0b11;

/**
 * Prefix width per lengthSizeMinusOne encoding. ISO/IEC 14496-15 reserves the
 * encoding 2, so a record carrying it names no width at all.
 */
const PREFIX_WIDTHS: readonly (number | undefined)[] = [1, 2, undefined, 4];

/**
 * Width of the AVCC length prefix this track frames every NAL with, read from
 * its avcC record, or null when the description names no usable width. Files
 * carry 1, 2, and 4, so nothing downstream may assume one of them.
 */
export function nalPrefixWidth(
  description: VideoDecoderConfig["description"],
): number | null {
  if (!description) return null;
  const record = avccRecord(description);
  if (record.length <= LENGTH_SIZE_MINUS_ONE_OFFSET) return null;
  const encoding =
    record[LENGTH_SIZE_MINUS_ONE_OFFSET] & LENGTH_SIZE_MINUS_ONE_MASK;
  return PREFIX_WIDTHS[encoding] ?? null;
}

function avccRecord(
  description: NonNullable<VideoDecoderConfig["description"]>,
): Uint8Array {
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(
      description.buffer,
      description.byteOffset,
      description.byteLength,
    );
  }
  return new Uint8Array(description);
}

/** Big-endian NAL length over exactly `width` bytes, the AVCC framing. */
function writePrefix(target: Uint8Array, width: number, length: number): void {
  for (let i = 0; i < width; i++) {
    target[i] = (length >>> ((width - 1 - i) * 8)) & 0xff;
  }
}

/**
 * The packet's NAL units in order, or null when the prefix widths do not walk
 * to exactly the end of the packet. That reading is the wrong one, and dropping
 * or reordering anything on it would throw away picture data.
 */
function nalUnits(
  packetBytes: Uint8Array,
  prefixWidth: number,
): Uint8Array[] | null {
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset < packetBytes.length) {
    if (offset + prefixWidth > packetBytes.length) return null;
    let length = 0;
    for (let i = 0; i < prefixWidth; i++)
      length = length * 256 + packetBytes[offset + i];
    offset += prefixWidth;
    if (length === 0 || offset + length > packetBytes.length) return null;
    units.push(packetBytes.subarray(offset, offset + length));
    offset += length;
  }
  return units;
}

function nalType(unit: Uint8Array): number {
  return unit[0] & NAL_TYPE_MASK;
}

/** The units re-framed at `prefixWidth`, the only framing this track's decoder
 *  can parse the packet under. */
function frameNalUnits(
  units: readonly Uint8Array[],
  prefixWidth: number,
): Uint8Array {
  let total = 0;
  for (const unit of units) total += prefixWidth + unit.length;
  const framed = new Uint8Array(total);
  let offset = 0;
  for (const unit of units) {
    writePrefix(framed.subarray(offset), prefixWidth, unit.length);
    offset += prefixWidth;
    framed.set(unit, offset);
    offset += unit.length;
  }
  return framed;
}

/**
 * Whether this access unit carries an IDR slice.
 *
 * A container's sync table names sync samples, and an H.264 sync sample is
 * usually an ordinary I picture rather than an IDR. The two differ in what a
 * decoder may assume about the pictures that follow: an IDR empties the
 * reference list, so nothing after it can name a picture from before it, while
 * an I picture leaves the list standing and the next reference frame is free to
 * name pictures the entry point never decoded. Only the IDR is an entry point
 * the bitstream cannot invalidate.
 *
 * Unreadable framing reads as not-IDR: the caller's fallback is to enter
 * further back, which costs a walk and is never wrong.
 */
export function isIdrAccessUnit(
  packetBytes: Uint8Array,
  prefixWidth: number,
): boolean {
  const units = nalUnits(packetBytes, prefixWidth);
  if (!units) return false;
  return units.some((unit) => nalType(unit) === IDR_SLICE);
}

/**
 * The access unit as the chunk that opens a decode, carrying the recovery-point
 * SEI that makes it a legal entry point.
 *
 * Where the SEI goes is the whole of it: an access unit delimiter, when the
 * packet has one, is required to be the access unit's first NAL, so the SEI goes
 * behind it. Ahead of it the access unit is malformed, and a decoder reading the
 * opening chunk to decide whether it is really a key frame is entitled to say it
 * is not.
 */
export function openingKeyPacket(
  packetBytes: Uint8Array,
  prefixWidth: number,
): Uint8Array {
  const units = nalUnits(packetBytes, prefixWidth);
  if (!units) return seiAhead(packetBytes, prefixWidth);
  const kept = units.filter((unit) => {
    const type = nalType(unit);
    return type < EXTENSION_NAL_FIRST || type > EXTENSION_NAL_LAST;
  });
  const seiAt =
    kept.length > 0 && nalType(kept[0]) === ACCESS_UNIT_DELIMITER ? 1 : 0;
  kept.splice(seiAt, 0, RECOVERY_POINT_SEI_NAL);
  return frameNalUnits(kept, prefixWidth);
}

/** `packetBytes` behind a recovery-point SEI framed at the file's own prefix
 *  width, since a prefix of any other width makes the whole packet unparseable. */
function seiAhead(packetBytes: Uint8Array, prefixWidth: number): Uint8Array {
  const seiBytes = prefixWidth + RECOVERY_POINT_SEI_NAL.length;
  const framed = new Uint8Array(seiBytes + packetBytes.length);
  writePrefix(framed, prefixWidth, RECOVERY_POINT_SEI_NAL.length);
  framed.set(RECOVERY_POINT_SEI_NAL, prefixWidth);
  framed.set(packetBytes, seiBytes);
  return framed;
}

/**
 * WebCodecs' standing demand for a key frame, which configure() and flush()
 * both arm and the next submitted chunk clears.
 */
export class KeyPacketRequirement {
  private pending = true;

  constructor(private readonly prefixWidth: number) {}

  /** Whether the demand still stands, so the chunk about to satisfy it can
   *  also be typed as the key chunk the decoder is waiting for. */
  get armed(): boolean {
    return this.pending;
  }

  /** Call after every configure() and flush(). */
  rearm(): void {
    this.pending = true;
  }

  /**
   * Bytes to submit for the next packet in decode order, carrying the
   * recovery-point SEI while the demand stands. The container reports sync
   * samples, never IDR frames, so the SEI goes on without inspecting the
   * packet; ahead of a true IDR it is a NAL the decoder ignores.
   */
  satisfy(packetBytes: Uint8Array): Uint8Array {
    if (!this.pending) return packetBytes;
    this.pending = false;
    return openingKeyPacket(packetBytes, this.prefixWidth);
  }
}
