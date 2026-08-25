import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  EncodedPacketSink,
  Input,
  ReadableStreamSource,
  UrlSource,
  VideoSampleSink,
} from "mediabunny";

import { FRAME_TIMELINE, PLAYBACK, SCRUB } from "./constants";
import type { CreateScrubCursorOptions } from "./create-scrub-cursor";
import {
  DecodeSession,
  sessionDrivable,
  type SessionFrameSource,
  type VideoDecoderLike,
} from "./decode-session";
import {
  nativeResolution,
  resolveDecodeDimensions,
  type DecodeResolutionStrategy,
} from "./decode-resolution";
import { FrameTimeline } from "./frame-timeline";
import type { KeyframeProbe } from "./keyframe-index";
import {
  idempotentSample,
  type ScrubTrackInfo,
  type VideoSampleLike,
} from "./scrub-cursor";
import {
  asSec,
  SourceKind,
  VideoEngineError,
  VideoEngineErrorCode,
  type DecodePath,
  type VideoSource,
} from "./types";

/**
 * A decoded frame handle: the slice of mediabunny's WrappedCanvas the runtime
 * paints, caches, and extracts. Only the canvas and its presentation timestamp
 * matter.
 */
export interface WrappedCanvasLike {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly timestamp: number;
}

/**
 * The slice of mediabunny's CanvasSink the runtime decodes through. getCanvas
 * does the random-access keyframe walk and GOP decode internally; canvases
 * streams forward for playback and stepping; canvasesAtTimestamps decodes a set
 * of sorted timestamps in one pass (the prefetch window and frame extraction).
 */
export interface CanvasFrameSource {
  getCanvas(timestampS: number): Promise<WrappedCanvasLike | null>;
  canvases(startS: number): AsyncGenerator<WrappedCanvasLike, void, unknown>;
  canvasesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<WrappedCanvasLike | null, void, unknown>;
}

/**
 * The opened decode primitives for one source: resolved track facts plus the
 * two sinks the runtime rides. Built once by openDecodeSource, so a consumer
 * never imports mediabunny and stays fake-injectable under test. This seam is
 * shared by the playback cursors and the playback-independent AnalysisSession,
 * so it lives here next to its producer rather than inside any one consumer.
 */
export interface DecodeSourceHandle {
  readonly track: ScrubTrackInfo;
  readonly sink: CanvasFrameSource;
  readonly keyframeProbe: KeyframeProbe;
  dispose(): Promise<void>;
}

/**
 * The slice of mediabunny's VideoSampleSink the runtime decodes through, mirror
 * for mirror with CanvasFrameSource but yielding live VideoSamples the zero-copy
 * WebGPU path imports directly. The sink yields raw samples; the cursor wraps
 * each in idempotentSample before emitting so the close obligation is safe to
 * discharge from every path.
 */
export interface SampleFrameSource {
  getSample(timestampS: number): Promise<VideoSampleLike | null>;
  samples(startS: number): AsyncGenerator<VideoSampleLike, void, unknown>;
  samplesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<VideoSampleLike | null, void, unknown>;
}

/**
 * The opened decode primitives for the zero-copy sample path: the same resolved
 * track facts and keyframe probe as DecodeSourceHandle, with the VideoSampleSink
 * standing in for the CanvasSink. Built only where zeroCopyViable approves the
 * path, so the rest of the runtime never reaches it by accident.
 */
export interface SampleSourceHandle {
  readonly track: ScrubTrackInfo;
  readonly sampleSink: SampleFrameSource;
  readonly keyframeProbe: KeyframeProbe;
  dispose(): Promise<void>;
}

/**
 * The opened decode primitives for the long-lived-decoder path: the same
 * resolved track facts and keyframe probe as the sink handles, with a
 * DecodeSession standing in for the sink. Built only where decodeSessionViable
 * approves the path.
 */
export interface SessionSourceHandle {
  readonly track: ScrubTrackInfo;
  readonly session: SessionFrameSource;
  readonly keyframeProbe: KeyframeProbe;
  dispose(): Promise<void>;
}

/**
 * One decoded frame, tagged by which sink produced it. A canvas frame from the
 * CanvasSink path; a sample frame from the VideoSampleSink path, carrying a live
 * VideoSample the cursor owns the close of. The cursor turns each into the
 * matching ScrubFrame kind, so the canvas-vs-sample branch lives in one place
 * rather than forking every cursor method.
 */
export type DecodedFrame =
  | {
      readonly kind: "canvas";
      readonly canvas: OffscreenCanvas | HTMLCanvasElement;
      readonly timestamp: number;
    }
  | {
      readonly kind: "sample";
      readonly sample: VideoSampleLike;
      readonly timestamp: number;
    };

/**
 * The decode seam both cursors ride, normalized over the two sink kinds: a
 * random-access read, a forward stream, and a sorted-timestamp batch, each
 * yielding a DecodedFrame. The provider also names the path it was built over,
 * which the scheduler reports so a human can see which machinery is decoding.
 */
export interface FrameProvider {
  readonly decodePath: DecodePath;
  readonly track: ScrubTrackInfo;
  readonly keyframeProbe: KeyframeProbe;
  getFrame(timestampS: number): Promise<DecodedFrame | null>;
  frames(startS: number): AsyncGenerator<DecodedFrame, void, unknown>;
  framesAt(
    timestamps: Iterable<number>,
  ): AsyncGenerator<DecodedFrame | null, void, unknown>;
  /**
   * Whether reaching `timestampS` would restart this provider from a keyframe
   * and decode everything in between. Only the long-lived decode session ever
   * answers true: the sink paths re-position per retrieval, so nothing they
   * are asked for is dearer than anything else.
   */
  wouldReanchor(timestampS: number): boolean;
  /**
   * Decoded frames a consumer may hold ahead of the playhead. Only the
   * zero-copy sample sink is constrained here: each of its frames pins a slot
   * in a fixed pool, so a deep queue starves the decoder that fills it. The
   * other paths hand out frames they own, and a cushion is what stops a decode
   * that overruns one frame interval from starving the next paint.
   */
  readonly playReadAhead: number;
  /**
   * Frames the decode machinery has produced since open, monotonic. On the
   * session path this counts every decoder output including discarded walk
   * pre-roll; the sink paths can only count what mediabunny yields, so their
   * figure is a floor, not the decoder's true output.
   */
  framesDecoded(): number;
  dispose(): Promise<void>;
}

/**
 * The forward-sample seam a batch range walk reads: the track's own timing
 * origin and one stream of its frames in presentation order. Both sample-
 * yielding paths present this shape, so the walk never branches on which decoder
 * it got, and every sample it hands over carries a close obligation.
 */
export interface WalkFrameSource {
  readonly track: ScrubTrackInfo;
  framesFrom(startS: number): AsyncGenerator<VideoSampleLike, void, unknown>;
}

/** A walk source and its disposal, held by whoever opened it. */
export interface WalkSourceHandle extends WalkFrameSource {
  dispose(): Promise<void>;
}

/** Discriminates the opened-source handle shapes at the cursor boundary. */
export type AnySourceHandle =
  DecodeSourceHandle | SampleSourceHandle | SessionSourceHandle;

function isSampleHandle(handle: AnySourceHandle): handle is SampleSourceHandle {
  return "sampleSink" in handle;
}

function isSessionHandle(
  handle: AnySourceHandle,
): handle is SessionSourceHandle {
  return "session" in handle;
}

/**
 * Wraps any opened-source handle in the unified FrameProvider. The two sample
 * paths wrap each yielded VideoSample in idempotentSample so the cursor can
 * discharge the close obligation from any path without double-free.
 */
export function openFrameProvider(handle: AnySourceHandle): FrameProvider {
  if (isSessionHandle(handle)) return sessionProvider(handle);
  if (isSampleHandle(handle)) return sampleProvider(handle);
  return canvasProvider(handle);
}

function canvasProvider(handle: DecodeSourceHandle): FrameProvider {
  let yielded = 0;
  const wrap = (w: WrappedCanvasLike): DecodedFrame => {
    yielded += 1;
    return { kind: "canvas", canvas: w.canvas, timestamp: w.timestamp };
  };
  return {
    decodePath: "canvas",
    playReadAhead: PLAYBACK.READ_AHEAD_CANVAS,
    track: handle.track,
    keyframeProbe: handle.keyframeProbe,
    wouldReanchor: () => false,
    async getFrame(t) {
      const w = await handle.sink.getCanvas(t);
      return w ? wrap(w) : null;
    },
    async *frames(startS) {
      for await (const w of handle.sink.canvases(startS)) yield wrap(w);
    },
    async *framesAt(timestamps) {
      // mediabunny's sink walks the track once and expects its timestamps
      // to climb, so this path sorts whatever order the caller chose.
      const ascending = [...timestamps].sort((a, b) => a - b);
      for await (const w of handle.sink.canvasesAtTimestamps(ascending)) {
        yield w ? wrap(w) : null;
      }
    },
    framesDecoded: () => yielded,
    dispose: () => handle.dispose(),
  };
}

const sampleFrame = (s: VideoSampleLike): DecodedFrame => ({
  kind: "sample",
  sample: idempotentSample(s),
  timestamp: s.timestamp,
});

function sampleProvider(handle: SampleSourceHandle): FrameProvider {
  let yielded = 0;
  const count = (s: VideoSampleLike): DecodedFrame => {
    yielded += 1;
    return sampleFrame(s);
  };
  return {
    decodePath: "sample",
    // Pool-bound: every outstanding frame is a slot the sink cannot refill.
    playReadAhead: 1,
    track: handle.track,
    keyframeProbe: handle.keyframeProbe,
    wouldReanchor: () => false,
    async getFrame(t) {
      const s = await handle.sampleSink.getSample(t);
      return s ? count(s) : null;
    },
    async *frames(startS) {
      for await (const s of handle.sampleSink.samples(startS)) yield count(s);
    },
    async *framesAt(timestamps) {
      const ascending = [...timestamps].sort((a, b) => a - b);
      for await (const s of handle.sampleSink.samplesAtTimestamps(ascending)) {
        yield s ? count(s) : null;
      }
    },
    framesDecoded: () => yielded,
    dispose: () => handle.dispose(),
  };
}

/**
 * Wraps the long-lived decode session in the FrameProvider. framesAt walks to
 * each requested timestamp in turn and yields every frame the walk decodes, not
 * only the requested ones: a decoder cannot skip forward inside a span, so the
 * frames in between are a free harvest of a decode already paid for. Walking to
 * each in turn rather than covering the whole request in one span is what keeps
 * a sweep of widely spaced timestamps from decoding everything between them; the
 * session re-anchors between them instead.
 */
function sessionProvider(handle: SessionSourceHandle): FrameProvider {
  return {
    decodePath: "session",
    playReadAhead: PLAYBACK.READ_AHEAD_CANVAS,
    track: handle.track,
    keyframeProbe: handle.keyframeProbe,
    async getFrame(t) {
      const s = await handle.session.frameAt(t);
      return s ? sampleFrame(s) : null;
    },
    async *frames(startS) {
      for await (const s of handle.session.framesFrom(startS))
        yield sampleFrame(s);
    },
    wouldReanchor: (t) => t < handle.session.reachableFromS,
    async *framesAt(timestamps) {
      // In the caller's order, deliberately. Ascending looks like the
      // decoder-friendly choice, and within one anchor span it is, but a
      // target behind the read head re-anchors and walks its whole prefix.
      // Sorting ascending puts the furthest BACKWARD target first, so that
      // walk runs before any frame ahead of the gesture. The caller knows
      // which frames the user is about to need; it orders them.
      for (const t of timestamps) {
        for await (const s of handle.session.framesCovering(t, t))
          yield sampleFrame(s);
      }
    },
    framesDecoded: () => handle.session.framesDecoded,
    dispose: () => handle.dispose(),
  };
}

/**
 * Opens a source on the CanvasSink path, the one every decodable source
 * supports. Track facts are resolved here too, so the consumer receives a fully
 * described handle and never touches mediabunny or the resolution math. Playback
 * consumers call openScrubSource instead and take whatever path the source
 * supports; this is for consumers that want canvases specifically.
 */
export async function openDecodeSource(
  options: CreateScrubCursorOptions,
): Promise<DecodeSourceHandle> {
  return canvasHandle(
    await openInput(options),
    options.poolSize ?? SCRUB.DEFAULT_POOL_SIZE,
  );
}

/**
 * Opens a source and routes it to the fastest decode path it supports: the
 * long-lived DecodeSession, then the zero-copy VideoSampleSink, then the
 * CanvasSink.
 *
 * The session's condition is the track's codec, which nothing can answer until
 * the container has been read, so the input opens first and the path is chosen
 * against what the opened track reports. The one input then serves whichever
 * path won.
 */
export async function openScrubSource(
  options: CreateScrubCursorOptions,
): Promise<AnySourceHandle> {
  const opened = await openInput(options);
  const decoderConfig = await opened.videoTrack.getDecoderConfig();
  if (
    decoderConfig &&
    decodeSessionViable({
      videoDecoderAvailable: detectVideoDecoder(),
      decoderConfig,
    })
  ) {
    return sessionHandle(opened, decoderConfig);
  }
  if (
    zeroCopyViable({
      prefer2d: options.prefer2d ?? false,
      strategy: opened.strategy,
      webgpuImportAvailable: detectWebgpuImport(),
    })
  ) {
    return sampleHandle(opened);
  }
  return canvasHandle(opened, options.poolSize ?? SCRUB.DEFAULT_POOL_SIZE);
}

/**
 * Opens a source for a batch walk over its frames, on its own input and its own
 * decoder. A walk reads thousands of frames in a row and a playback cursor is
 * serving a screen, so the two never share: whatever a walk does to its read
 * head, no gesture is waiting behind it.
 *
 * The CanvasSink path is not offered here. It yields recycled canvases with no
 * duration and no close, and a walk's whole contract is real frames with the
 * timing they were encoded with, so a source that cannot present samples cannot
 * be walked. Frames arrive at the source's native resolution; nothing downscales
 * them on the way out.
 */
export async function openWalkSource(
  source: VideoSource,
): Promise<WalkSourceHandle> {
  const opened = await openInput({ source });
  const decoderConfig = await opened.videoTrack.getDecoderConfig();
  if (
    decoderConfig &&
    decodeSessionViable({
      videoDecoderAvailable: detectVideoDecoder(),
      decoderConfig,
    })
  ) {
    const handle = sessionHandle(opened, decoderConfig);
    return walkHandle(handle, (startS) => handle.session.framesFrom(startS));
  }
  const handle = sampleHandle(opened);
  return walkHandle(handle, (startS) => handle.sampleSink.samples(startS));
}

function walkHandle(
  handle: { track: ScrubTrackInfo; dispose: () => Promise<void> },
  stream: (startS: number) => AsyncGenerator<VideoSampleLike, void, unknown>,
): WalkSourceHandle {
  return {
    track: handle.track,
    async *framesFrom(startS) {
      for await (const sample of stream(startS)) yield idempotentSample(sample);
    },
    dispose: () => handle.dispose(),
  };
}

function canvasHandle(
  opened: OpenedInput,
  poolSize: number,
): DecodeSourceHandle {
  // Width-only: CanvasSink derives height from native aspect. This sizes the
  // canvas the frame is drawn into; it does NOT reduce decode cost. The codec
  // decodes the full coded frame regardless, and CanvasSink resizes after, so
  // the win is paint work and cached-blit memory, not decode throughput.
  const sink = new CanvasSink(opened.videoTrack, {
    poolSize,
    width: opened.track.decodeWidth,
  });
  return {
    track: opened.track,
    sink,
    keyframeProbe: new EncodedPacketSink(opened.videoTrack),
    dispose: async () => {
      opened.input.dispose();
    },
  };
}

/** The zero-copy sample path: a VideoSampleSink in place of the CanvasSink. It
 *  takes no width, so frames arrive at the source's own dimensions. */
function sampleHandle(opened: OpenedInput): SampleSourceHandle {
  return {
    track: opened.track,
    sampleSink: new VideoSampleSink(opened.videoTrack),
    keyframeProbe: new EncodedPacketSink(opened.videoTrack),
    dispose: async () => {
      opened.input.dispose();
    },
  };
}

/**
 * The long-lived-decoder path: an EncodedPacketSink feeding a DecodeSession that
 * holds one VideoDecoder across seeks. The same sink answers the keyframe probe,
 * so anchor resolution and packet reads share one reader. The session drives the
 * decoder itself and every frame arrives at the source's own dimensions; the
 * resolved decodeWidth still sizes the canvas and the cache blits, which scale
 * the native frame down as they draw it.
 */
function sessionHandle(
  opened: OpenedInput,
  config: VideoDecoderConfig,
): SessionSourceHandle {
  const packets = new EncodedPacketSink(opened.videoTrack);
  const session = new DecodeSession({
    packets,
    config,
    createDecoder: webCodecsDecoder,
  });
  return {
    track: opened.track,
    session,
    keyframeProbe: packets,
    dispose: async () => {
      session.close();
      opened.input.dispose();
    },
  };
}

function webCodecsDecoder(init: VideoDecoderInit): VideoDecoderLike {
  const decoder = new VideoDecoder(init);
  return {
    configure: (config) => decoder.configure(config),
    decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
    flush: () => decoder.flush(),
    reset: () => decoder.reset(),
    close: () => decoder.close(),
  };
}

interface OpenedInput {
  readonly input: Input;
  readonly videoTrack: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>> &
    object;
  readonly track: ScrubTrackInfo;
  readonly strategy: DecodeResolutionStrategy;
}

/** Opens the input, resolves the primary video track, and runs the decode
 *  resolution math, the work every path shares before one is chosen.
 *  Throws VideoEngineError(DecodeUnsupported) when no video track exists or the
 *  browser cannot decode the track's codec, so an undecodable source surfaces a
 *  typed state instead of a silent stall. */
async function openInput(
  options: CreateScrubCursorOptions,
): Promise<OpenedInput> {
  const { source } = options;
  const input = new Input({
    formats: ALL_FORMATS,
    source: toMediabunnySource(source),
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new VideoEngineError(
      VideoEngineErrorCode.DecodeUnsupported,
      "openInput: source has no video track",
    );
  }
  if (!(await videoTrack.canDecode())) {
    const decoderConfig = await videoTrack.getDecoderConfig();
    throw new VideoEngineError(
      VideoEngineErrorCode.DecodeUnsupported,
      `openInput: browser cannot decode this video track's codec ${
        decoderConfig?.codec ?? "(unknown)"
      }`,
    );
  }
  const displayWidth = videoTrack.displayWidth;
  const displayHeight = videoTrack.displayHeight;
  const durationS = asSec(await readTrackDurationS(videoTrack));
  const timeline = await readFrameTimeline(videoTrack);
  // Mediabunny ships a measured native fps via computePacketStats:
  // averagePacketRate "for video tracks, equals the average frame rate". We
  // bound the packet sample to a small slice so the load promise doesn't stall
  // on long files. The result is good enough for 1/nativeFps step math;
  // sub-frame precision falls through to stepForward/stepBackward.
  const nativeFps = await readTrackFps(videoTrack);
  const strategy = options.decodeStrategy ?? nativeResolution();
  const { width: decodeWidth, height: decodeHeight } = resolveDecodeDimensions(
    strategy,
    {
      nativeWidth: displayWidth,
      nativeHeight: displayHeight,
      displayWidth: options.viewport?.displayWidth ?? null,
      devicePixelRatio: options.viewport?.devicePixelRatio ?? 1,
    },
  );
  return {
    input,
    videoTrack,
    strategy,
    track: {
      width: displayWidth,
      height: displayHeight,
      decodeWidth,
      decodeHeight,
      nativeFps,
      durationS,
      firstTimestampS: timeline.timeAt(0),
      timeline,
    },
  };
}

interface TrackWithTimeResolution {
  getTimeResolution?: () => Promise<number>;
  timeResolution?: number;
}

/**
 * Walks the track's packets metadata-only and records each one's timestamp in
 * the container's own integer grain, which is the grain every timestamp of the
 * track is a whole multiple of.
 *
 * Decode order is not presentation order on a B-frame source, so the table is
 * sorted before it is indexed, and the trailing frame's duration comes from the
 * packet that ends up last in that order.
 */
async function readFrameTimeline(videoTrack: unknown): Promise<FrameTimeline> {
  const track = videoTrack as TrackWithTimeResolution;
  const tickRate =
    typeof track.getTimeResolution === "function"
      ? await track.getTimeResolution()
      : (track.timeResolution ?? FRAME_TIMELINE.FALLBACK_TICK_RATE);
  const sink = new EncodedPacketSink(
    videoTrack as ConstructorParameters<typeof EncodedPacketSink>[0],
  );
  const ticks: number[] = [];
  let lastTicks = -Infinity;
  let lastDurationTicks = 0;
  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    const at = Math.round(packet.timestamp * tickRate);
    if (ticks.length >= FRAME_TIMELINE.MAX_FRAMES) {
      throw new VideoEngineError(
        VideoEngineErrorCode.DecodeUnsupported,
        `openInput: source video track carries more than ${FRAME_TIMELINE.MAX_FRAMES} frames`,
      );
    }
    ticks.push(at);
    if (at >= lastTicks) {
      lastTicks = at;
      lastDurationTicks = Math.round(packet.duration * tickRate);
    }
  }
  if (ticks.length === 0) {
    throw new VideoEngineError(
      VideoEngineErrorCode.DecodeUnsupported,
      "openInput: source video track has no frames",
    );
  }
  ticks.sort((a, b) => a - b);
  return FrameTimeline.from({
    lastDurationTicks,
    tickRate,
    ticks: Float64Array.from(ticks),
  });
}

/**
 * Inputs the zero-copy gate reasons over. Held as data, not probed live, so the
 * predicate is pure and unit-testable: the caller measures the realm once and
 * passes the facts in.
 */
export interface ZeroCopyContext {
  /** True when the consumer pinned the 2D renderer. */
  readonly prefer2d: boolean;
  /** The decode strategy the source will open with. */
  readonly strategy: DecodeResolutionStrategy;
  /** Whether decode runs at the source's native size (the strategy requests no
   *  downscale). A downscale rules the path out: the sample arrives native, so
  /** Whether the worker realm has WebGPU with importExternalTexture, the API
   *  the zero-copy import needs. */
  readonly webgpuImportAvailable: boolean;
}

/**
 * The gate. True when the 2D path is not pinned and the realm offers WebGPU's
 * importExternalTexture. False keeps the byte-identical CanvasSink path; this is
 * the one place the additive path is allowed to switch on.
 *
 * A requested downscale does not refuse the path. The sample sink yields frames
 * at the source's native size whatever the strategy asks for, and the shader
 * samples them into the box it draws, so the GPU performs the downscale during
 * sampling. The strategy stays a canvas and cache concern, which is what the
 * long-lived session already treats it as.
 */
export function zeroCopyViable(ctx: ZeroCopyContext): boolean {
  if (ctx.prefer2d) return false;
  if (!ctx.webgpuImportAvailable) return false;
  return true;
}

/**
 * Inputs the long-lived-decoder gate reasons over, held as data for the same
 * reason ZeroCopyContext is.
 *
 * Decode resolution is deliberately absent. The session owns its decoder and
 * always decodes at the source's native size, so a requested downscale is a
 * canvas and cache concern rather than a reason to refuse the path.
 */
export interface DecodeSessionContext {
  /** Whether this realm has WebCodecs. The session builds and drives its own
   *  VideoDecoder rather than decoding through a mediabunny sink. */
  readonly videoDecoderAvailable: boolean;
  /** The opened track's decoder config, which decides whether the session's
   *  anchor trick applies to this bitstream. */
  readonly decoderConfig: VideoDecoderConfig;
}

/**
 * The gate. The session reaches a non-IDR anchor by declaring it a recovery
 * point, which only holds for AVCC-framed H.264 carrying its parameter sets, so
 * every other source keeps the mediabunny sinks.
 */
export function decodeSessionViable(ctx: DecodeSessionContext): boolean {
  if (!ctx.videoDecoderAvailable) return false;
  return sessionDrivable(ctx.decoderConfig);
}

/** Whether this realm exposes the WebCodecs decoder the session constructs. */
export function detectVideoDecoder(): boolean {
  return (
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder ===
    "function"
  );
}

/**
 * Probes the worker realm for WebGPU with importExternalTexture. Checks for the
 * method on the prototype rather than acquiring a device, so it is synchronous
 * and cheap; the actual device acquisition still happens (and can still fail
 * back to 2D) in the renderer.
 */
export function detectWebgpuImport(): boolean {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (!nav?.gpu) return false;
  const deviceCtor = (globalThis as { GPUDevice?: { prototype?: object } })
    .GPUDevice;
  const proto = deviceCtor?.prototype as
    { importExternalTexture?: unknown } | undefined;
  return typeof proto?.importExternalTexture === "function";
}

export function toMediabunnySource(
  source: VideoSource,
): UrlSource | BlobSource | ReadableStreamSource {
  switch (source.kind) {
    case SourceKind.Url:
      return new UrlSource(source.url);
    case SourceKind.Blob:
      return new BlobSource(source.blob);
    case SourceKind.Stream:
      return new ReadableStreamSource(source.stream);
  }
}

/**
 * Whether a source can be opened a second time, which the hang-recovery path
 * needs to rebuild a wedged decoder. A URL re-fetches and a Blob re-reads, so
 * both re-open cleanly. A ReadableStream is consumed once and cannot be rewound,
 * so a rebuild on it would open onto an exhausted stream; the watchdog falls back
 * to a degraded-but-alive state instead of rebuilding for that kind.
 */
export function isReopenableSource(source: VideoSource): boolean {
  return source.kind !== SourceKind.Stream;
}

interface TrackWithMaybeDuration {
  computeDuration?: () => Promise<number>;
  duration?: number;
  durationS?: number;
}

async function readTrackDurationS(track: unknown): Promise<number> {
  const t = track as TrackWithMaybeDuration;
  if (typeof t.computeDuration === "function") {
    const d = await t.computeDuration();
    return Number.isFinite(d) ? d : 0;
  }
  if (typeof t.duration === "number") return t.duration;
  if (typeof t.durationS === "number") return t.durationS;
  return 0;
}

interface TrackWithMaybeStats {
  computePacketStats?: (
    targetPacketCount?: number,
  ) => Promise<{ averagePacketRate?: number }>;
}

/**
 * Reads the native frame rate from mediabunny's computePacketStats. Bounded to a
 * small packet sample so load() does not stall on long files. Returns null when
 * the track exposes no stats API or the value is non-finite.
 */
async function readTrackFps(track: unknown): Promise<number | null> {
  const t = track as TrackWithMaybeStats;
  if (typeof t.computePacketStats !== "function") return null;
  try {
    const stats = await t.computePacketStats(120);
    const fps = stats?.averagePacketRate;
    if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0)
      return null;
    return fps;
  } catch {
    return null;
  }
}
