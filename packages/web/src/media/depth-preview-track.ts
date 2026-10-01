import type { EncodedPacket } from "mediabunny";
import {
  MediaErrorKind,
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
} from "supervision-js-core";
import {
  createMainThreadLumaCopier,
  type DepthPreviewLumaCopier,
  type DepthPreviewLumaPath,
} from "#render-preparation/depth/preview-luma";
import { formatSeconds, withinDecoderDeadline } from "./decoder-deadline";
import { MediaSourceError } from "./media-errors";
import { readTrackFrameIndex, type TrackFrameIndex } from "./track-frame-index";

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
/**
 * How long a decoder may sit on frames it was given, with nothing more it
 * can be fed, before it is flushed for them. Some decoders return frames only
 * once more input arrives or a flush asks for them.
 */
const STALLED_DECODER_FLUSH_MILLISECONDS = 100;
/**
 * How long a flush may go without returning a frame before the decoder is
 * taken for stuck. A flush waits on the decoder alone, never the network.
 */
const FLUSH_SILENCE_MILLISECONDS = 3000;
/** How long the browser may take to say whether it decodes the preview. */
export const DECODER_SUPPORT_MILLISECONDS = 3000;
const MICROSECONDS_PER_SECOND = 1_000_000;

export type DepthPreviewTrackInput = string | URL | ArrayBuffer | Uint8Array;

export interface DepthPreviewTrackOptions {
  /** Defaults to the browser's own choice. */
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
  /** Stops opening: the container's reads are cancelled. */
  readonly signal?: AbortSignal;
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

/**
 * The 8-bit preview video of a depth clip, decoded to luma codes.
 *
 * It holds one `VideoDecoder` for its whole life and resets it for each new
 * run, so a seek or a drag never has two of its decoders alive at once,
 * however slowly the browser tears an old one down.
 */
export interface DepthPreviewTrackReader {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  /** Frame start times, in seconds from the preview's first frame. */
  readonly times: Float64Array;
  keyIndexAtOrBefore(index: number): number;
  /**
   * Starts decoding at the key frame at or before `fromIndex`. The run
   * replaces the previous one, whose `next` answers null from then on.
   */
  decode(
    fromIndex: number,
    options?: DepthPreviewDecodeOptions,
  ): DepthPreviewDecodeRun;
  /** How decoded frames reached their codes; null before the first. */
  lumaPath(): DepthPreviewLumaPath | null;
  dispose(): void;
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
  const { signal } = options;
  const stop = () => media.dispose();

  signal?.addEventListener("abort", stop, { once: true });

  try {
    if (signal?.aborted) throw signal.reason;

    const track = await media.getPrimaryVideoTrack();

    if (!track) {
      throw new MediaSourceError(
        MediaErrorKind.NoVideoTrack,
        "The depth preview has no video track.",
      );
    }

    const [config, rotation, width, height] = await Promise.all([
      track.getDecoderConfig(),
      track.getRotation(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
    ]);

    if (
      !config ||
      typeof VideoDecoder === "undefined" ||
      !(await isDecoderConfigSupported(config))
    ) {
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

    const timeline = await readTrackFrameIndex(track);
    const packetSink = new mediabunny.EncodedPacketSink(track);

    if (signal?.aborted) throw signal.reason;

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
      width,
    });
  } catch (error) {
    media.dispose();
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Whether the browser decodes `config`, given a deadline: a browser that
 * never answers is taken as one that does not.
 */
async function isDecoderConfigSupported(config: VideoDecoderConfig) {
  try {
    const support = await withinDecoderDeadline(
      VideoDecoder.isConfigSupported(config),
      DECODER_SUPPORT_MILLISECONDS,
      "VideoDecoder.isConfigSupported",
    );

    return support.supported === true;
  } catch {
    return false;
  }
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
  readonly timeline: TrackFrameIndex;
  readonly width: number;
  readonly height: number;
  readonly dispose?: () => void;
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
  let lumaPath: DepthPreviewLumaPath | null = null;

  /** A decoded timestamp is its packet's, truncated to microseconds. */
  const indexOfTimestamp = (microseconds: number) => {
    const time = microseconds / MICROSECONDS_PER_SECOND;
    const times = timeline.sourceTimes;
    let low = 0;
    let high = times.length - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;

      if (times[middle] < time - PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS) {
        low = middle + 1;
      } else if (
        times[middle] >
        time + PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS
      ) {
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
  };

  const ensureDecoder = () => {
    if (decoder && decoder.state !== "closed") return decoder;

    const created = new Decoder({
      error: (error) => {
        // The decoder closes itself on an error; the next run makes another.
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

    return created;
  };

  /** The copier closes `frame`. Resolves null for a frame the copier lost. */
  const copyLuma = (
    frame: VideoFrame,
    index: number,
  ): Promise<DepthPreviewLumaFrame | null> => {
    const correction = options.correction ?? null;
    const copied =
      options.copier?.copy(frame, correction) ??
      pageCopier.copy(frame, correction);

    return copied.then((result) => {
      if (!result) return null;
      lumaPath = result.path === "rgb" ? "rgb" : (lumaPath ?? "plane");

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
    /** Last time the decoder took a chunk or returned a frame. */
    let lastProgressAt = performance.now();
    /**
     * The decoder sat on every frame it was given: it is fed past the
     * in-flight limit up to the next key frame, and flushed there.
     */
    let stalled = false;
    /** A key frame read while stalled, fed once the flush before it ends. */
    let heldKey: EncodedPacket | null = null;
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
        setTimeout(
          wake,
          hearsDequeue
            ? DECODER_IDLE_POLL_MILLISECONDS
            : DECODER_POLL_MILLISECONDS,
        );
      });

    /**
     * Asks the decoder for every frame it holds. After a flush the decoder
     * takes only a key frame, so one mid-run waits for the next key frame;
     * the one at the end of input ends the run.
     */
    const flush = (atEnd: boolean) => {
      flushing = true;
      lastProgressAt = performance.now();
      runDecoder.flush().then(
        () => {
          flushing = false;
          stalled = false;
          if (atEnd) flushed = true;
          wake();
        },
        (error: unknown) => {
          // A reset for the next run aborts this flush; that is no failure.
          if (!cancelled && !isAbortError(error)) failure ??= { error };
          flushing = false;
          if (atEnd) flushed = true;
          wake();
        },
      );
    };

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
        delivered += 1;
        lastProgressAt = performance.now();
        if (!flushing) stalled = false;

        const index = indexOfTimestamp(frame.timestamp);

        if (index < 0 || !keep(index)) {
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
            // A frame the copier lost is skipped; the caller asks for it again.
            if (frame) return frame;
            continue;
          }
          if (flushed) return null;

          if (flushing) {
            // Only the decoder can end a flush; one silent this long never will.
            if (
              performance.now() - lastProgressAt >
              FLUSH_SILENCE_MILLISECONDS
            ) {
              failure ??= {
                error: new Error(
                  `The depth preview decoder returned no frame for ${formatSeconds(FLUSH_SILENCE_MILLISECONDS)} of a flush.`,
                ),
              };
              continue;
            }
            await Promise.race([sleep(), cancellation]);
            continue;
          }

          if (
            !packetsDone &&
            runDecoder.decodeQueueSize < MAX_DECODE_QUEUE_SIZE &&
            (stalled || fed - delivered < MAX_FRAMES_IN_FLIGHT)
          ) {
            let packet = heldKey;

            heldKey = null;
            if (!packet) {
              const reading = readPacket();

              reading.catch(() => undefined);
              packet = await Promise.race([reading, cancellation]);
              if (cancelled || disposed) return null;
            }
            if (packet) {
              if (stalled && packet.type === "key" && fed > delivered) {
                // Every frame before this key frame is in the decoder, so a
                // flush now returns them all and loses none.
                heldKey = packet;
                flush(false);
                continue;
              }
              runDecoder.decode(packet.toEncodedVideoChunk());
              fed += 1;
              lastProgressAt = performance.now();
              continue;
            }
            packetsDone = true;
          }

          if (packetsDone) {
            flush(true);
            continue;
          }

          if (
            !stalled &&
            fed - delivered >= MAX_FRAMES_IN_FLIGHT &&
            runDecoder.decodeQueueSize === 0 &&
            performance.now() - lastProgressAt >=
              STALLED_DECODER_FLUSH_MILLISECONDS
          ) {
            stalled = true;
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

    lumaPath: () => lumaPath,

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
