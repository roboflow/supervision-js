import {
  isIdrAccessUnit,
  KeyPacketRequirement,
  nalPrefixWidth,
} from "./key-packet";
import { drawRotated, type Rotation } from "./rotation";
import type { VideoSampleLike } from "./scrub-cursor";
import { VideoEngineError, VideoEngineErrorCode } from "./types";

/**
 * One packet as the session submits it. Mirrors the fields of mediabunny's
 * EncodedPacket the decoder needs, so the session never imports mediabunny.
 */
export interface EncodedPacketLike {
  readonly data: Uint8Array;
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly duration: number;
}

export interface PacketRetrievalOptionsLike {
  readonly metadataOnly?: boolean;
  readonly verifyKeyPackets?: boolean;
}

/** The slice of mediabunny's EncodedPacketSink the session decodes through. */
export interface PacketSource {
  getKeyPacket(
    timestamp: number,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null>;
  getNextKeyPacket(
    packet: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): Promise<EncodedPacketLike | null>;
  packets(
    startPacket?: EncodedPacketLike,
    endPacket?: EncodedPacketLike,
    options?: PacketRetrievalOptionsLike,
  ): AsyncGenerator<EncodedPacketLike, void, unknown>;
}

/** The slice of WebCodecs' VideoDecoder the session drives. Chunks cross as
 *  inits so the session never reaches for a platform constructor. */
export interface VideoDecoderLike {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunkInit): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/**
 * One decoded picture and the timing of the packet that produced it.
 *
 * The timing is the container's rather than `VideoFrame.timestamp`, matching
 * what mediabunny's sinks publish on every other decode path: where a picture
 * sits is a fact about the file, not about what a platform decoder stamped on
 * it.
 */
interface DecodedPicture {
  readonly frame: VideoFrame;
  readonly timestampS: number;
  readonly durationS: number;
}

/**
 * Half a microsecond: a submitted timestamp survives the round trip through the
 * decoder as whole microseconds, so anything closer than this is the same
 * packet and anything further is a decoder counting on a clock of its own.
 */
const TIMING_MATCH_S = 5e-7;

interface PacketTiming {
  readonly timestampS: number;
  readonly durationS: number;
}

/**
 * The packet a decode was opened from, and whether anything further back is
 * left to try if it turns out not to decode.
 *
 * A sync sample is only a promise that a decoder may *start* there, and on an
 * open GOP that promise is not kept: the first reference picture after a
 * non-IDR entry point is free to name reference pictures from before it, and a
 * decoder that entered at the sync sample never decoded those. So an anchor is
 * a hypothesis until a picture comes back, and `hasFallback` is what says
 * whether a failed hypothesis leaves the session anywhere else to go.
 */
interface DecodeEntry {
  readonly anchor: EncodedPacketLike;
  /** Whole-microsecond timestamp, the identity a float timestamp cannot be. */
  readonly key: number;
  readonly hasFallback: boolean;
}

function anchorKey(timestampS: number): number {
  return Math.round(timestampS * MICROSECONDS_PER_SECOND);
}

export interface DecodeSessionOptions {
  readonly packets: PacketSource;
  readonly config: VideoDecoderConfig;
  readonly createDecoder: (init: VideoDecoderInit) => VideoDecoderLike;
  /**
   * The track's quarter turn, which the session's frames carry and its draw
   * applies. A raw decoded picture holds the stored pixels and nothing about
   * the display matrix, so this is the only route the turn has here, and a
   * caller that forgets it paints every portrait recording sideways.
   */
  readonly rotation: Rotation;
  /**
   * Ceiling on waiting for one decoder output while chunks are in flight;
   * defaults to OUTPUT_TIMEOUT_MS. Overridable so a test can drive the
   * silent-decoder path without waiting out the production ceiling.
   */
  readonly outputTimeoutMs?: number;
}

/**
 * Verification rejects every sync sample that is not a true IDR, which collapses
 * a container's sync table down to the handful of real IDRs and drags the anchor
 * back by that much. Off, the honest table stands and a recovery-point SEI makes
 * the non-IDR anchor legal to decode from.
 *
 * The anchor is read with its bytes: it is both the packet the walk starts from
 * and the first chunk submitted, and a reader refuses a metadata-only packet as
 * the start of a full-data walk.
 */
const ANCHOR_PROBE: PacketRetrievalOptionsLike = { verifyKeyPackets: false };

/**
 * The fallback anchor read: the last IDR at or before the target, found by
 * reading bitstreams rather than trusting the sync table. Reached only once an
 * optimistic anchor has actually failed, since it drags the entry point back to
 * the previous IDR and every picture between there and the target is decoded
 * and thrown away.
 */
const IDR_PROBE: PacketRetrievalOptionsLike = { verifyKeyPackets: true };

/** The packet that closes the anchor span is read for its timestamp alone. */
const SPAN_END_PROBE: PacketRetrievalOptionsLike = {
  metadataOnly: true,
  verifyKeyPackets: false,
};

/**
 * Chunks kept outstanding in the decoder. H.264 lets a decoder hold up to
 * sixteen pictures before it has to emit one, and a stream that uses the whole
 * buffer emits nothing at all until the seventeenth chunk arrives, so a
 * shallower pipeline waits forever on the frame it just asked for.
 */
const DECODER_PIPELINE_CHUNKS = 17;

/** Decoded frames held before the session stops feeding the decoder. These are
 *  full-resolution and the session's own to retain, unlike the pipeline above,
 *  which is the decoder's. */
const READY_FRAMES = 4;

/** Absorbs float error when a requested bound lands on a frame's timestamp. */
const BOUND_EPSILON_S = 1e-6;

/**
 * Ceiling on waiting for ONE decoder output while chunks are in flight, which a
 * healthy decoder answers in single-digit milliseconds. It is not the ceiling on
 * a walk (that is the caller's, and a legitimate GOP walk runs far longer); it
 * exists so a decoder that goes silent surfaces as a failure instead of parking
 * the surface for the length of the walk ceiling. It only ever runs while output
 * is owed, so an idle session cannot trip it however long it sits.
 */
const OUTPUT_TIMEOUT_MS = 5_000;

const MICROSECONDS_PER_SECOND = 1e6;

/** The recovery-point SEI is an H.264 NAL behind an AVCC length prefix, so the
 *  session opens only codecs framed that way. */
const AVCC_H264_CODEC = /^avc1\./;

/**
 * Width the session must frame its SEI at to drive a track with this config, or
 * null when it cannot drive the track at all. The SEI it prepends to a non-IDR
 * anchor is an H.264 NAL behind an AVCC length prefix, and the width of that
 * prefix is only knowable from the avcC record in `description`, so a config
 * without one is unusable however well-formed the rest of it looks.
 */
function drivablePrefixWidth(config: VideoDecoderConfig): number | null {
  if (!AVCC_H264_CODEC.test(config.codec)) return null;
  return nalPrefixWidth(config.description);
}

/**
 * Whether the session can drive a track with this decoder config. The gate that
 * routes a source here and the constructor that refuses everything else read the
 * same predicate.
 */
export function sessionDrivable(config: VideoDecoderConfig): boolean {
  return drivablePrefixWidth(config) !== null;
}

/**
 * The three retrievals the session answers, mirror for mirror with the sink
 * slices the other decode paths ride. Held as an interface so the provider that
 * wraps it stays fake-injectable under test.
 */
export interface SessionFrameSource {
  frameAt(targetS: number): Promise<VideoSampleLike | null>;
  framesFrom(startS: number): AsyncGenerator<VideoSampleLike, void, unknown>;
  framesCovering(
    startS: number,
    endS: number,
  ): AsyncGenerator<VideoSampleLike, void, unknown>;
  /** Earliest position still reachable without re-anchoring, or -Infinity when
   *  the session has not been positioned yet. A decoder only moves forward, so
   *  asking for anything below this costs a walk from the enclosing keyframe. */
  readonly reachableFromS: number;
  /** Every frame the decoder has output since open, discarded pre-roll
   *  included; monotonic. */
  readonly framesDecoded: number;
}

/**
 * One long-lived VideoDecoder, held across seeks.
 *
 * A decoder can only ever move forward, and every flush re-arms its demand for a
 * key frame, so a runtime that flushes per retrieval pays a walk back to the
 * nearest true IDR on every seek. This session flushes only at end of stream:
 * a seek at-or-ahead of the read head, inside the current anchor span, decodes
 * only the packets between the two, and a backward jump or a jump past the span
 * re-anchors. Positioning is the only thing that costs a walk.
 *
 * One decoder serving several readers is the whole point, and it is also the
 * hazard: a scrub's frameAt and playback's framesFrom drive the same decoder,
 * the same packet iterator, and the same queue of decoded frames. So every
 * retrieval takes the decoder exclusively for the length of one frame, and a
 * reader displaced by someone else's re-anchor is told, rather than left to read
 * the emptied queue as end of stream and stop for good.
 *
 * Frames are handed out as VideoSampleLike and their close is the caller's, the
 * same obligation the zero-copy sample path carries.
 */
export class DecodeSession implements SessionFrameSource {
  private readonly keyPacket: KeyPacketRequirement;
  private readonly prefixWidth: number;
  private decoder: VideoDecoderLike | null = null;
  private iterator: AsyncGenerator<EncodedPacketLike, void, unknown> | null =
    null;
  private peeked: EncodedPacketLike | null = null;
  /** Timestamp of the key packet after the anchor: the end of the span a
   *  forward seek can reach without re-anchoring. */
  private spanEndS = Infinity;
  private exhausted = true;
  /** Timings the decoder still owes pictures for, in presentation order. */
  private readonly pending: PacketTiming[] = [];
  private readonly decoded: DecodedPicture[] = [];
  private wake: (() => void) | null = null;
  /**
   * Latched once the decoder is judged unable to decode this source at all.
   * Every later retrieval refuses with it instead of re-anchoring onto the
   * same failure, which is what turns a silent forever-retry into one honest
   * error the caller can show.
   */
  private stalledError: VideoEngineError | null = null;
  /**
   * The current entry point's failure, held only until the walk that is owed a
   * picture decides what it means. It condemns the anchor, never the session:
   * a source whose sync table names one bad entry point still decodes from
   * every other one, and latching the first failure is what turned a seek into
   * a poisoned GOP into a player that never painted again.
   */
  private anchorError: VideoEngineError | null = null;
  /** The entry currently feeding the decoder, or null before the first one. */
  private entry: DecodeEntry | null = null;
  /** Entry points a decoder error has ruled out, by whole-microsecond
   *  timestamp. Only ever grows: a bitstream does not change. */
  private readonly rejectedAnchors = new Set<number>();
  /** Where the live retrieval wants to be, so a re-anchor after a failed entry
   *  aims at the position the caller asked for rather than the anchor's. */
  private entryTargetS = 0;
  /** The last picture handed out since the caller last chose a position, so a
   *  re-anchor mid-walk resumes rather than replays. */
  private servedS = -Infinity;
  private closed = false;
  private anchors = 0;
  private framesDecodedCount = 0;
  /** Where the decoder sits, kept in step with what it hands out. Read
   *  synchronously by callers deciding what to ask for, so it cannot await. */
  private reachable = -Infinity;
  /** Serializes retrievals; see the class note on shared-decoder exclusivity. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Bumped by every re-anchor, so a reader can tell whether the decoder is
   *  still where it left it or has been moved under it by another reader. */
  private epoch = 0;

  private readonly outputTimeoutMs: number;

  private readonly rotation: Rotation;

  constructor(private readonly options: DecodeSessionOptions) {
    this.outputTimeoutMs = options.outputTimeoutMs ?? OUTPUT_TIMEOUT_MS;
    this.rotation = options.rotation;
    const prefixWidth = drivablePrefixWidth(options.config);
    if (prefixWidth === null) {
      throw new VideoEngineError(
        VideoEngineErrorCode.DecodeUnsupported,
        `DecodeSession: ${options.config.codec} is not AVCC-framed H.264`,
      );
    }
    this.prefixWidth = prefixWidth;
    this.keyPacket = new KeyPacketRequirement(prefixWidth);
  }

  /** Times the session has configured the decoder onto an anchor. */
  get anchorCount(): number {
    return this.anchors;
  }

  /** Every frame the decoder has ever output, including walk pre-roll that is
   *  discarded before the target: the honest denominator for what a paint
   *  actually cost. Monotonic for the session's lifetime. */
  get framesDecoded(): number {
    return this.framesDecodedCount;
  }

  /** See SessionFrameSource. The oldest frame decoded but not yet handed out
   *  when there is one, since those are still servable, else the last position
   *  handed out. */
  get reachableFromS(): number {
    const queued = this.decoded[0];
    if (queued) return queued.timestampS;
    return this.reachable;
  }

  /** The frame at or before `targetS`, or null when nothing precedes it. */
  async frameAt(targetS: number): Promise<VideoSampleLike | null> {
    const landed = await this.exclusive(() => this.land(targetS));
    return landed ? videoFrameSample(landed, this.rotation) : null;
  }

  /**
   * Frames from `startS` onward, beginning at the frame at or before it. The
   * walk from the anchor up to `startS` is decoded but not yielded, since the
   * caller asked to start there.
   *
   * Playback rides this for the length of a session, so it outlives any number
   * of scrubs. When one of those moved the decoder, the walk resumes from the
   * last frame it handed out rather than ending.
   */
  async *framesFrom(
    startS: number,
  ): AsyncGenerator<VideoSampleLike, void, unknown> {
    let handedOutS: number | null = null;
    let seenEpoch = this.epoch;
    for (;;) {
      const picture = await this.exclusive(() => {
        if (handedOutS === null) return this.land(startS);
        if (seenEpoch !== this.epoch) return this.resumeAfter(handedOutS);
        return this.pull(Infinity);
      });
      if (!picture) return;
      handedOutS = picture.timestampS;
      seenEpoch = this.epoch;
      yield videoFrameSample(picture, this.rotation);
    }
  }

  /**
   * Every frame decoded while covering `[startS, endS]`, including the walk
   * from the anchor. Those prefix frames cost the same decode either way, so
   * yielding them hands the caller a span of frames for the price of the one
   * it asked for.
   *
   * This serves speculative sweeps, so a re-anchor by anyone else ends it:
   * chasing the span back would spend a foreground decode's worth of decoder
   * time on frames nobody is waiting for.
   */
  async *framesCovering(
    startS: number,
    endS: number,
  ): AsyncGenerator<VideoSampleLike, void, unknown> {
    let positioned = false;
    let seenEpoch = 0;
    for (;;) {
      const picture = await this.exclusive(async () => {
        if (!positioned) {
          await this.positionFor(startS);
          positioned = true;
        } else if (seenEpoch !== this.epoch) {
          return null;
        }
        return this.pull(endS);
      });
      if (!picture) return;
      seenEpoch = this.epoch;
      yield videoFrameSample(picture, this.rotation);
    }
  }

  /**
   * Runs `op` with the decoder to itself. Retrievals interleave at frame
   * granularity, which bounds how long a foreground seek waits behind a
   * background sweep at one frame, while keeping any one walk's view of the
   * packet iterator, the in-flight count, and the decoded queue consistent.
   */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The first frame after `afterS` once another reader has moved the decoder.
   * Re-positions and discards the frames already handed out, so a walk picks
   * up exactly where it left off however far away the decoder was taken.
   */
  private async resumeAfter(afterS: number): Promise<DecodedPicture | null> {
    await this.positionFor(afterS);
    for (;;) {
      const picture = await this.pull(Infinity);
      if (!picture) return null;
      if (picture.timestampS > afterS + BOUND_EPSILON_S) return picture;
      picture.frame.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.iterator?.return();
    this.iterator = null;
    this.peeked = null;
    this.exhausted = true;
    this.discardDecoded();
    this.decoder?.close();
    this.decoder = null;
    this.wake?.();
  }

  /** Decodes through `targetS` and returns the last frame at or before it,
   *  closing the frames walked past. */
  private async land(targetS: number): Promise<DecodedPicture | null> {
    await this.positionFor(targetS);
    let landed: DecodedPicture | null = null;
    for (;;) {
      const picture = await this.pull(targetS);
      if (!picture) return landed;
      landed?.frame.close();
      landed = picture;
    }
  }

  private async positionFor(targetS: number): Promise<void> {
    if (this.closed) return;
    if (this.stalledError) throw this.stalledError;
    this.entryTargetS = targetS;
    if (this.decoder && !this.exhausted) {
      const headS = await this.readHeadS();
      if (headS !== null && targetS >= headS && targetS < this.spanEndS) return;
    }
    this.servedS = -Infinity;
    await this.anchorAt(targetS);
  }

  /** The earliest position still reachable without re-anchoring: the oldest
   *  frame decoded but not yet handed out, or the next packet in line when
   *  there is none. Decode runs ahead of the read, so the packet alone would
   *  put the head past frames the session can still serve. */
  private async readHeadS(): Promise<number | null> {
    const queued = this.decoded[0];
    if (queued) return queued.timestampS;
    const packet = await this.peek();
    return packet ? packet.timestamp : null;
  }

  private async anchorAt(targetS: number): Promise<void> {
    const entry = await this.resolveEntry(targetS);
    void this.iterator?.return();
    this.iterator = null;
    this.peeked = null;
    this.exhausted = true;
    this.entry = null;
    this.anchorError = null;
    this.quiesce();
    if (!entry || this.closed) return;
    this.spanEndS = await this.spanEndAfter(entry.anchor, targetS);
    this.configureDecoder();
    this.iterator = this.options.packets.packets(entry.anchor);
    this.entry = entry;
    this.exhausted = false;
    this.anchors++;
    this.epoch++;
    this.reachable = entry.anchor.timestamp;
  }

  /**
   * The packet to open a decode of `targetS` from: the container's own sync
   * sample, unless a decoder has already proved that one is not a legal entry
   * point, in which case the last verified IDR at or before the target.
   *
   * A sync sample that is itself an IDR is already the furthest-back entry
   * worth reaching for, so a failure there is a failure of the source.
   */
  private async resolveEntry(targetS: number): Promise<DecodeEntry | null> {
    const sync = await this.options.packets.getKeyPacket(targetS, ANCHOR_PROBE);
    if (sync) {
      const key = anchorKey(sync.timestamp);
      if (!this.rejectedAnchors.has(key)) {
        return {
          anchor: sync,
          key,
          hasFallback: !isIdrAccessUnit(sync.data, this.prefixWidth),
        };
      }
    }
    const idr = await this.options.packets.getKeyPacket(targetS, IDR_PROBE);
    if (!idr) return null;
    return { anchor: idr, key: anchorKey(idr.timestamp), hasFallback: false };
  }

  /**
   * Where the span a forward seek can reach without re-anchoring ends: the
   * first sync sample past the target that is still worth anchoring at.
   *
   * Skipping the rejected ones is what keeps the pre-roll paid for once. Ending
   * the span at an entry point already known not to decode would send the very
   * next seek into that GOP back to the same rejected anchor and back through
   * the same walk to recover from it.
   */
  private async spanEndAfter(
    anchor: EncodedPacketLike,
    targetS: number,
  ): Promise<number> {
    let key: EncodedPacketLike = anchor;
    for (;;) {
      const next = await this.options.packets.getNextKeyPacket(
        key,
        SPAN_END_PROBE,
      );
      if (!next) return Infinity;
      if (
        next.timestamp > targetS + BOUND_EPSILON_S &&
        !this.rejectedAnchors.has(anchorKey(next.timestamp))
      ) {
        return next.timestamp;
      }
      key = next;
    }
  }

  /** Drops the work in flight and the frames it produced, in one turn, so no
   *  output from the old anchor can land against the new one. */
  private quiesce(): void {
    this.decoder?.reset();
    this.pending.length = 0;
    this.discardDecoded();
  }

  private configureDecoder(): void {
    try {
      if (!this.decoder) {
        // Named so the callback can check that the decoder reporting the
        // failure is still the one driving the session: a decoder dropped for
        // erroring may report again afterwards, and that report must not
        // condemn the anchor built to replace it.
        const built: VideoDecoderLike = this.options.createDecoder({
          output: (frame) => this.receive(frame),
          error: (error) => this.fail(built, error),
        });
        this.decoder = built;
      }
      // Without prompt per-frame emission a session that never flushes has
      // no way to get its frames out, so the whole flush-free design rests
      // here.
      this.decoder.configure({
        ...this.options.config,
        optimizeForLatency: true,
      });
    } catch (cause) {
      throw this.stall("the decoder refused to configure", cause);
    }
    this.keyPacket.rearm();
  }

  /** One frame at or before `boundS`, or null once the bound is passed. A frame
   *  decoded past the bound stays queued for the next read rather than being
   *  handed out or thrown away. */
  private async pull(boundS: number): Promise<DecodedPicture | null> {
    // Every hand-out moves the decoder forward past that frame.
    for (;;) {
      if (this.closed) return null;
      if (this.stalledError) throw this.stalledError;
      const failed = this.anchorError;
      if (failed) {
        await this.enterFurtherBack(failed);
        continue;
      }
      await this.fill();
      const ready = this.decoded[0];
      if (ready) {
        // Re-entering further back re-decodes ground the walk already
        // covered, and the caller has seen those pictures.
        if (ready.timestampS <= this.servedS + BOUND_EPSILON_S) {
          this.decoded.shift();
          ready.frame.close();
          continue;
        }
        if (ready.timestampS > boundS + BOUND_EPSILON_S) return null;
        this.decoded.shift();
        this.reachable = ready.timestampS;
        this.servedS = ready.timestampS;
        return ready;
      }
      // The pipeline holds requests a failed decoder will never answer, so
      // waiting on them is waiting out the ceiling for nothing.
      if (this.anchorError) continue;
      if (this.pending.length === 0) return null;
      // Nothing is left to submit at end of stream, so a flush is the only
      // way to get the last frames out.
      if (this.exhausted) await this.drain();
      else await this.awaitOutput();
    }
  }

  /**
   * Re-opens the decode from the last entry point ahead of the failed one,
   * which for an open GOP means the previous IDR plus a walk to the target.
   *
   * The failed anchor is struck off for the life of the session, so the cost is
   * paid once per bad entry point rather than once per seek into it. When there
   * is nothing further back to enter from, the failure is the source's and it
   * latches here.
   */
  private async enterFurtherBack(failure: VideoEngineError): Promise<void> {
    const entry = this.entry;
    if (!entry?.hasFallback) throw this.latch(failure);
    this.rejectedAnchors.add(entry.key);
    // An errored WebCodecs decoder is already closed and cannot be
    // reconfigured, so the replacement anchor needs a replacement decoder.
    this.decoder = null;
    await this.anchorAt(Math.max(this.entryTargetS, this.servedS));
    if (!this.entry) throw this.latch(failure);
  }

  /**
   * Keeps the decoder's pipeline fed, regardless of which frame is being read.
   * A decoder emits nothing until it holds enough pictures, so submitting only
   * as far as the requested frame leaves the session waiting on output it is
   * refusing to make possible. Feeding stops once the frames already decoded
   * pile up, which is what bounds the memory the session holds.
   */
  private async fill(): Promise<void> {
    while (
      this.decoder &&
      // The error arrives between two of the reads below, and a decoder that
      // has reported one is closed: every further chunk is refused, and being
      // refused is what would condemn the whole session for a failure the
      // anchor already owns.
      !this.anchorError &&
      this.pending.length < DECODER_PIPELINE_CHUNKS &&
      this.decoded.length < READY_FRAMES
    ) {
      const packet = await this.peek();
      if (!packet) return;
      if (this.closed || this.anchorError) return;
      this.peeked = null;
      this.awaitTiming({
        timestampS: packet.timestamp,
        durationS: packet.duration,
      });
      // The chunk that opens the decode is the only one submitted as a key
      // chunk: a later sync sample is a recovery point, not an IDR, and the
      // decoder verifies the claim. It is the same chunk that carries the
      // SEI, so one latch answers both.
      const opensDecode = this.keyPacket.armed;
      const data = this.keyPacket.satisfy(packet.data);
      try {
        this.decoder.decode({
          type: opensDecode ? "key" : "delta",
          timestamp: Math.round(packet.timestamp * MICROSECONDS_PER_SECOND),
          duration: Math.round(packet.duration * MICROSECONDS_PER_SECOND),
          data,
        });
      } catch (cause) {
        throw this.stall("the decoder refused a chunk", cause);
      }
    }
  }

  private async peek(): Promise<EncodedPacketLike | null> {
    if (this.peeked) return this.peeked;
    if (!this.iterator || this.exhausted) return null;
    const result = await this.iterator.next();
    if (result.done) {
      this.exhausted = true;
      return null;
    }
    this.peeked = result.value;
    return this.peeked;
  }

  private async drain(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder) return;
    await decoder.flush();
    this.pending.length = 0;
    this.keyPacket.rearm();
  }

  private awaitOutput(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const owed = this.pending.length;
      const timer = setTimeout(() => {
        this.wake = null;
        // Drop the work this was waiting on before handing the failure
        // out. The chunks it timed out on stay counted as in flight
        // otherwise, and the next retrieval inherits a decoder that owes
        // frames it will never produce, so it waits out the same timeout
        // again instead of re-anchoring onto a clean one.
        this.quiesce();
        this.exhausted = true;
        // Which failure this is turns on the output counter, not on the
        // timer: a decoder that has handed frames back and then gone quiet
        // is one a rebuild can recover, and a decoder that has answered a
        // full pipeline of requests with nothing at all may never have been
        // given a legal place to start, which is the anchor's to answer for.
        if (this.framesDecodedCount === 0) {
          this.anchorError ??= new VideoEngineError(
            VideoEngineErrorCode.DecoderStalled,
            `DecodeSession: the decoder acknowledged ${owed} decode requests and produced no frame`,
          );
          resolve();
          return;
        }
        reject(
          new VideoEngineError(
            VideoEngineErrorCode.BackendCrashed,
            `DecodeSession: decoder produced no output in ${this.outputTimeoutMs}ms with ${owed} chunks in flight`,
          ),
        );
      }, this.outputTimeoutMs);
      this.wake = () => {
        this.wake = null;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Files a submitted chunk's timing in presentation order, which is the order
   * pictures come back in and is not the order chunks go in on a B-frame
   * source.
   */
  private awaitTiming(timing: PacketTiming): void {
    let at = this.pending.length;
    while (at > 0 && this.pending[at - 1].timestampS > timing.timestampS) at--;
    this.pending.splice(at, 0, timing);
  }

  /**
   * A decoder that echoes the timestamp it was handed names its own pending
   * entry, which survives an output being dropped. One that counts from an
   * origin of its own names nothing, and position is all that is left. Taking
   * position alone would let a single dropped output shift every picture after
   * it onto the wrong detections, permanently and without a symptom.
   */
  private claimTiming(frame: VideoFrame): PacketTiming | undefined {
    const submittedS = frame.timestamp / MICROSECONDS_PER_SECOND;
    const at = this.pending.findIndex(
      (timing) => Math.abs(timing.timestampS - submittedS) <= TIMING_MATCH_S,
    );

    return at === -1 ? this.pending.shift() : this.pending.splice(at, 1)[0];
  }

  private receive(frame: VideoFrame): void {
    this.framesDecodedCount += 1;
    const timing = this.claimTiming(frame);
    if (this.closed || !timing) {
      frame.close();
      return;
    }
    this.decoded.push({ frame, ...timing });
    this.wake?.();
  }

  private fail(from: VideoDecoderLike, error: unknown): void {
    if (from !== this.decoder) return;
    this.anchorError ??= new VideoEngineError(
      VideoEngineErrorCode.DecoderStalled,
      "DecodeSession: the decoder reported an error",
      error,
    );
    this.wake?.();
  }

  /** Latches the terminal failure and returns it. First writer wins, so the
   *  cause a caller is handed is the one that started the failure rather than
   *  whichever consequence surfaced last. */
  private stall(what: string, cause?: unknown): VideoEngineError {
    return this.latch(
      new VideoEngineError(
        VideoEngineErrorCode.DecoderStalled,
        `DecodeSession: ${what}`,
        cause,
      ),
    );
  }

  private latch(error: VideoEngineError): VideoEngineError {
    this.stalledError ??= error;
    return this.stalledError;
  }

  private discardDecoded(): void {
    for (const picture of this.decoded) picture.frame.close();
    this.decoded.length = 0;
  }
}

/** A decoded frame in the runtime's own sample vocabulary, so a session frame
 *  and a VideoSampleSink frame reach the renderer the same way. */
function videoFrameSample(
  { frame, timestampS, durationS }: DecodedPicture,
  rotation: Rotation,
): VideoSampleLike {
  const quarterTurn = rotation % 180 !== 0;
  return {
    timestamp: timestampS,
    duration: durationS,
    rotation,
    toVideoFrame: () => frame.clone(),
    draw: (ctx, dx, dy, dWidth, dHeight) => {
      drawRotated(
        ctx,
        frame,
        rotation,
        dx,
        dy,
        dWidth ?? (quarterTurn ? frame.displayHeight : frame.displayWidth),
        dHeight ?? (quarterTurn ? frame.displayWidth : frame.displayHeight),
      );
    },
    close: () => frame.close(),
  };
}
