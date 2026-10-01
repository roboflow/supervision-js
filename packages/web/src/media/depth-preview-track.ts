import type { EncodedPacket, InputVideoTrack } from "mediabunny";
import { MediaErrorKind } from "supervision-js-core";
import {
  createMainThreadLumaCopier,
  type DepthPreviewLumaCopier,
  type DepthPreviewLumaPath,
} from "#render-preparation/depth-preview-luma";
import { MediaSourceError } from "./media-errors";

/**
 * Decode requests kept waiting in the decoder. Enough to keep a hardware
 * decoder busy, few enough that a seek throws little work away.
 */
const MAX_DECODE_QUEUE_SIZE = 4;
/**
 * Frames fed to the decoder and not yet out of it. A decoder holds a few for
 * reordering; more than this means it is not keeping up, so feeding waits.
 */
const MAX_FRAMES_IN_FLIGHT = 24;
/** How long a wait for the decoder sleeps when it cannot hear `dequeue`. */
const DECODER_POLL_MILLISECONDS = 4;
/** The same, as a safety net, for a decoder that does say `dequeue`. */
const DECODER_IDLE_POLL_MILLISECONDS = 25;
/** A decoded frame's timestamp is a packet's, truncated to microseconds. */
const TIMESTAMP_MATCH_TOLERANCE_SECONDS = 0.0005;
const MICROSECONDS_PER_SECOND = 1_000_000;

export type DepthPreviewTrackInput = string | URL | ArrayBuffer | Uint8Array;

export interface DepthPreviewTrackOptions {
  /** Which decoder the browser should pick. Defaults to its own choice. */
  readonly hardwareAcceleration?: HardwareAcceleration;
  /**
   * Maps each code the decoder returns to the code written, for a decoder
   * known to change them.
   */
  readonly correction?: Uint8Array | null;
  /**
   * Copies decoded frames' luma out: the render-preparation worker's, to
   * keep the copies off the page. Defaults to copying on the page.
   */
  readonly copier?: DepthPreviewLumaCopier;
}

export type { DepthPreviewLumaPath };

/** One decoded preview frame's luma, one byte per map pixel. */
export interface DepthPreviewLumaFrame {
  /** Frame index on the preview's own timeline, in presentation order. */
  readonly index: number;
  readonly luma: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** One pass of decoding, from a key frame forward. */
export interface DepthPreviewDecodeRun {
  /**
   * The next decoded frame, or null once the track has ended or the run was
   * cancelled. Frames arrive in the decoder's output order, which is
   * presentation order except on browsers that reorder late.
   */
  next(): Promise<DepthPreviewLumaFrame | null>;
  cancel(): void;
}

export interface DepthPreviewDecodeOptions {
  /** Frames this answers false for are closed without copying their pixels. */
  readonly keep?: (index: number) => boolean;
}

/** Counters for diagnostics and the benchmark. */
export interface DepthPreviewTrackStats {
  /** Decoders constructed; a new one only replaces one that failed. */
  readonly decodersCreated: number;
  /** Decoders constructed and not yet closed: one at most. */
  readonly liveDecoders: number;
  readonly runsStarted: number;
  readonly framesDecoded: number;
  readonly framesCopied: number;
  readonly framesSkipped: number;
  /** Main-thread time spent handing frames over and copying their luma. */
  readonly copyMainThreadMs: number;
  readonly lumaPath: DepthPreviewLumaPath | null;
}

/**
 * The 8-bit preview video of a depth clip, decoded to luma codes.
 *
 * It holds one `VideoDecoder` for its whole life. A new run resets that
 * decoder instead of opening another, so a seek or a drag never has two of
 * its decoders alive at once, whatever the browser does about tearing the old
 * one down.
 */
export interface DepthPreviewTrackReader {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  /** Frame start times, in seconds from the preview's first frame. */
  readonly times: Float64Array;
  /** The key frame decoding has to start at to reach frame `index`. */
  keyIndexAtOrBefore(index: number): number;
  /**
   * Starts decoding at the key frame at or before `fromIndex`. The run
   * replaces the previous one, whose `next` answers null from then on.
   */
  decode(
    fromIndex: number,
    options?: DepthPreviewDecodeOptions,
  ): DepthPreviewDecodeRun;
  getStats(): DepthPreviewTrackStats;
  dispose(): void;
}

/** The preview's frames in presentation order, as the container times them. */
export interface DepthPreviewTimeline {
  /** Seconds from the first presented frame. */
  readonly times: Float64Array;
  /** Container presentation times in seconds, which packets are found by. */
  readonly sourceTimes: Float64Array;
  /** Presentation indices of key frames, ascending. */
  readonly keyIndices: Int32Array;
}

export interface DepthPreviewTimelinePacket {
  /** Presentation timestamp in ticks of the track's time resolution. */
  readonly ticks: number;
  readonly durationTicks: number;
  readonly key: boolean;
}

/**
 * The presented frames of a track from its packets, by the rules the video
 * engine reads its own track by: one frame per presentation instant, and
 * pre-roll that ends at or before zero dropped. A depth preview and the video
 * it describes are then compared frame for frame on the same terms.
 */
export function readDepthPreviewTimeline(
  packets: readonly DepthPreviewTimelinePacket[],
  tickRate: number,
): DepthPreviewTimeline {
  if (!(tickRate > 0)) {
    throw new RangeError(
      `Depth preview time resolution ${tickRate} is not positive.`,
    );
  }

  const sorted = [...packets].sort((a, b) => a.ticks - b.ticks);
  const ticks: number[] = [];
  const keys: boolean[] = [];
  let lastDurationTicks = 0;

  for (const packet of sorted) {
    if (ticks.length > 0 && ticks[ticks.length - 1] === packet.ticks) {
      keys[keys.length - 1] ||= packet.key;
      continue;
    }
    ticks.push(packet.ticks);
    keys.push(packet.key);
    lastDurationTicks = packet.durationTicks;
  }

  let first = 0;

  while (first < ticks.length) {
    const end =
      first + 1 < ticks.length
        ? ticks[first + 1]
        : ticks[first] + lastDurationTicks;

    if (end > 0) break;
    first += 1;
  }
  if (first === ticks.length) {
    throw new RangeError("The depth preview has no presented frames.");
  }

  const visible = ticks.slice(first);
  const origin = Math.max(0, visible[0]);
  const keyIndices: number[] = [];

  for (let index = 0; index < visible.length; index += 1) {
    if (keys[first + index]) keyIndices.push(index);
  }

  return {
    keyIndices: Int32Array.from(keyIndices),
    sourceTimes: Float64Array.from(visible, (tick) => tick / tickRate),
    times: Float64Array.from(
      visible,
      (tick) => (Math.max(0, tick) - origin) / tickRate,
    ),
  };
}

/**
 * Opens a depth preview video: an 8-bit grayscale H.264 whose luma codes are
 * depth. Mediabunny is loaded on first use, so a page without a preview never
 * downloads it.
 */
export async function openDepthPreviewTrack(
  input: DepthPreviewTrackInput,
  options: DepthPreviewTrackOptions = {},
): Promise<DepthPreviewTrackReader> {
  const mediabunny = await import("mediabunny");
  const source =
    typeof input === "string" || input instanceof URL
      ? new mediabunny.UrlSource(input)
      : new mediabunny.BufferSource(input);
  const media = new mediabunny.Input({
    formats: [mediabunny.MP4, mediabunny.QTFF],
    source,
  });

  try {
    const track = await media.getPrimaryVideoTrack();

    if (!track) {
      throw new MediaSourceError(
        MediaErrorKind.NoVideoTrack,
        "The depth preview has no video track.",
      );
    }

    const [config, canDecode, rotation, width, height] = await Promise.all([
      track.getDecoderConfig(),
      track.canDecode(),
      track.getRotation(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
    ]);

    if (!config || !canDecode || typeof VideoDecoder === "undefined") {
      throw new MediaSourceError(
        MediaErrorKind.UnsupportedFormat,
        `This browser cannot decode the depth preview's codec ${config?.codec ?? "(unknown)"}.`,
      );
    }
    if (rotation !== 0) {
      throw new RangeError(
        `The depth preview is rotated ${rotation} degrees; depth previews must not be rotated.`,
      );
    }

    const timeline = await readDepthPreviewTrackTimeline(track);
    const packetSink = new mediabunny.EncodedPacketSink(track);

    return createDepthPreviewTrackReader({
      config: options.hardwareAcceleration
        ? { ...config, hardwareAcceleration: options.hardwareAcceleration }
        : config,
      copier: options.copier,
      correction: options.correction ?? null,
      dispose: () => media.dispose(),
      height,
      packetSink,
      timeline,
      track,
      width,
    });
  } catch (error) {
    media.dispose();
    throw error;
  }
}

/**
 * A track's presented frames from its packet table, without decoding a
 * frame: what a preview is checked against its video by.
 */
export async function readDepthPreviewTrackTimeline(
  track: InputVideoTrack,
): Promise<DepthPreviewTimeline> {
  const { EncodedPacketSink } = await import("mediabunny");
  const tickRate = await track.getTimeResolution();

  return readDepthPreviewTimeline(
    await readTimelinePackets(new EncodedPacketSink(track), tickRate),
    tickRate,
  );
}

async function readTimelinePackets(
  sink: InstanceType<typeof import("mediabunny").EncodedPacketSink>,
  tickRate: number,
): Promise<DepthPreviewTimelinePacket[]> {
  const packets: DepthPreviewTimelinePacket[] = [];

  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    packets.push({
      durationTicks: Math.round(packet.duration * tickRate),
      key: packet.type === "key",
      ticks: Math.round(packet.timestamp * tickRate),
    });
  }

  return packets;
}

interface PacketReader {
  getKeyPacket(
    timestamp: number,
    options: { verifyKeyPackets: boolean },
  ): Promise<EncodedPacket | null>;
  getFirstKeyPacket(options: {
    verifyKeyPackets: boolean;
  }): Promise<EncodedPacket | null>;
  packets(
    start?: EncodedPacket,
    end?: EncodedPacket,
  ): AsyncGenerator<EncodedPacket, void, unknown>;
}

/** The decoding half, apart from the container so it can be driven directly. */
export function createDepthPreviewTrackReader(options: {
  readonly config: VideoDecoderConfig;
  readonly copier?: DepthPreviewLumaCopier;
  readonly correction?: Uint8Array | null;
  readonly packetSink: PacketReader;
  readonly timeline: DepthPreviewTimeline;
  readonly width: number;
  readonly height: number;
  readonly track?: InputVideoTrack;
  readonly dispose?: () => void;
  /** The decoder constructor; the browser's by default. */
  readonly VideoDecoder?: typeof VideoDecoder;
}): DepthPreviewTrackReader {
  const Decoder = options.VideoDecoder ?? globalThis.VideoDecoder;
  const { timeline } = options;
  const frameCount = timeline.times.length;
  let decoder: VideoDecoder | null = null;
  let hearsDequeue = false;
  let current: RunState | null = null;
  let disposed = false;
  const pageCopier = createMainThreadLumaCopier();
  const stats = {
    copyMainThreadMs: 0,
    decodersCreated: 0,
    framesCopied: 0,
    framesDecoded: 0,
    framesSkipped: 0,
    liveDecoders: 0,
    lumaPath: null as DepthPreviewLumaPath | null,
    runsStarted: 0,
  };

  const indexOfTimestamp = (microseconds: number) => {
    const time = microseconds / MICROSECONDS_PER_SECOND;
    const times = timeline.sourceTimes;
    let low = 0;
    let high = times.length - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;

      if (times[middle] < time - TIMESTAMP_MATCH_TOLERANCE_SECONDS) {
        low = middle + 1;
      } else if (times[middle] > time + TIMESTAMP_MATCH_TOLERANCE_SECONDS) {
        high = middle - 1;
      } else {
        return middle;
      }
    }

    return -1;
  };

  const closeDecoder = () => {
    if (!decoder) return;
    if (decoder.state !== "closed") decoder.close();
    decoder = null;
    stats.liveDecoders = 0;
  };

  const ensureDecoder = () => {
    if (decoder && decoder.state !== "closed") return decoder;

    const created = new Decoder({
      error: (error) => {
        // The decoder closes itself on an error; the next run makes another.
        stats.liveDecoders = 0;
        decoder = null;
        current?.fail(error);
      },
      output: (frame) => {
        if (current && !current.cancelled) current.accept(frame);
        else frame.close();
      },
    });

    hearsDequeue = typeof created.addEventListener === "function";
    created.addEventListener?.("dequeue", () => current?.wake());
    decoder = created;
    stats.decodersCreated += 1;
    stats.liveDecoders = 1;

    return created;
  };

  /**
   * Hands one frame to the copier, which closes it, and keeps the time the
   * page spent on it. Null for a frame the copier lost.
   */
  const copyLuma = (
    frame: VideoFrame,
    index: number,
  ): Promise<DepthPreviewLumaFrame | null> => {
    const started = performance.now();
    const correction = options.correction ?? null;
    const copied =
      options.copier?.copy(frame, correction) ??
      pageCopier.copy(frame, correction);

    stats.copyMainThreadMs += performance.now() - started;

    return copied.then((result) => {
      if (!result) {
        stats.framesSkipped += 1;
        return null;
      }
      stats.copyMainThreadMs += result.busyMs;
      stats.framesCopied += 1;
      stats.lumaPath =
        result.path === "rgb" ? "rgb" : (stats.lumaPath ?? "plane");

      return {
        height: result.height,
        index,
        luma: result.luma,
        width: result.width,
      };
    });
  };

  interface RunState {
    readonly cancelled: boolean;
    accept(frame: VideoFrame): void;
    fail(error: unknown): void;
    wake(): void;
    cancel(): void;
  }

  const startRun = (
    fromIndex: number,
    runOptions: DepthPreviewDecodeOptions,
  ): DepthPreviewDecodeRun => {
    const keep = runOptions.keep ?? (() => true);
    const ready: Promise<DepthPreviewLumaFrame | null>[] = [];
    const runDecoder = ensureDecoder();
    let cancelled = false;
    let failure: { error: unknown } | null = null;
    let packets: AsyncGenerator<EncodedPacket, void, unknown> | null = null;
    let packetsDone = false;
    let fed = 0;
    let delivered = 0;
    let flushing = false;
    let flushed = false;
    let wakeUp: (() => void) | null = null;
    let onCancel: () => void = () => undefined;
    /** Settles when the run is cancelled, so no await outlives it. */
    const cancellation = new Promise<null>((resolve) => {
      onCancel = () => resolve(null);
    });

    const wake = () => {
      const resolve = wakeUp;

      wakeUp = null;
      resolve?.();
    };

    const sleep = () =>
      new Promise<void>((resolve) => {
        wakeUp = resolve;
        // A decoder that never says `dequeue` is polled instead.
        setTimeout(
          wake,
          hearsDequeue
            ? DECODER_IDLE_POLL_MILLISECONDS
            : DECODER_POLL_MILLISECONDS,
        );
      });

    const readPacket = async () => {
      if (!packets) {
        const from = Math.min(Math.max(0, fromIndex), frameCount - 1);
        const start =
          (await options.packetSink.getKeyPacket(timeline.sourceTimes[from], {
            verifyKeyPackets: true,
          })) ??
          (await options.packetSink.getFirstKeyPacket({
            verifyKeyPackets: true,
          }));

        if (cancelled) return null;
        if (!start) return null;
        packets = options.packetSink.packets(start);
      }

      const result = await packets.next();

      return result.done ? null : result.value;
    };

    const state: RunState = {
      get cancelled() {
        return cancelled;
      },
      accept(frame) {
        stats.framesDecoded += 1;
        delivered += 1;

        const index = indexOfTimestamp(frame.timestamp);

        if (index < 0 || !keep(index)) {
          stats.framesSkipped += 1;
          frame.close();
          wake();
          return;
        }
        const copied = copyLuma(frame, index);

        // A run cancelled before reading this copy never awaits it.
        copied.catch(() => undefined);
        ready.push(copied);
        wake();
      },
      fail(error) {
        failure ??= { error };
        wake();
      },
      wake,
      cancel() {
        if (cancelled) return;
        cancelled = true;
        void packets?.return(undefined).catch(() => undefined);
        onCancel();
        wake();
      },
    };

    current = state;
    stats.runsStarted += 1;
    if (runDecoder.state === "configured") runDecoder.reset();
    runDecoder.configure(options.config);

    return {
      async next() {
        while (true) {
          if (cancelled || disposed) return null;
          if (failure) throw failure.error;

          const head = ready.shift();

          if (head) {
            const frame = await Promise.race([head, cancellation]);

            if (cancelled || disposed) return null;
            // A frame the copier lost is a frame the window asks for again.
            if (frame) return frame;
            continue;
          }
          if (flushed) return null;

          if (
            !packetsDone &&
            runDecoder.decodeQueueSize < MAX_DECODE_QUEUE_SIZE &&
            fed - delivered < MAX_FRAMES_IN_FLIGHT
          ) {
            const reading = readPacket();

            reading.catch(() => undefined);

            const packet = await Promise.race([reading, cancellation]);

            if (cancelled || disposed) return null;
            if (packet) {
              runDecoder.decode(packet.toEncodedVideoChunk());
              fed += 1;
              continue;
            }
            packetsDone = true;
          }

          if (packetsDone && !flushing) {
            flushing = true;
            runDecoder.flush().then(
              () => {
                flushed = true;
                wake();
              },
              (error: unknown) => {
                // A reset for the next run aborts this flush; that is no failure.
                if (!cancelled && !isAbortError(error)) failure ??= { error };
                flushed = true;
                wake();
              },
            );
            continue;
          }

          await Promise.race([sleep(), cancellation]);
        }
      },

      cancel: () => state.cancel(),
    };
  };

  return {
    frameCount,
    height: options.height,
    times: timeline.times,
    width: options.width,

    keyIndexAtOrBefore(index) {
      const keys = timeline.keyIndices;
      let low = 0;
      let high = keys.length - 1;
      let found = 0;

      while (low <= high) {
        const middle = (low + high) >> 1;

        if (keys[middle] <= index) {
          found = keys[middle];
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      return found;
    },

    decode(fromIndex, runOptions = {}) {
      if (disposed) throw new Error("The depth preview track is closed.");
      current?.cancel();

      return startRun(fromIndex, runOptions);
    },

    getStats: () => ({ ...stats }),

    dispose() {
      if (disposed) return;
      disposed = true;
      current?.cancel();
      current = null;
      closeDecoder();
      options.dispose?.();
    },
  };
}

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
