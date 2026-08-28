import { DIAGNOSTICS, HANG_RECOVERY } from "./constants";
import type { DecodeResolutionStrategy } from "./decode-resolution";
import type { DiagnosticsSnapshot, EngineDiagnostics } from "./diagnostics";
import { DiagnosticsStore } from "./diagnostics-store";
import {
  type FrameId,
  type FrameLanding,
  FrameTimeline,
} from "./frame-timeline";
import type { SeekIntent } from "./scrub-cursor";
import type { EngineTrace } from "./trace-recorder";
import {
  canvasBindingRefused,
  type EngineChannel,
  type EngineReadySnapshot,
  type PaintSeq,
  type PlaybackState,
  PlaybackStatus,
  type PresentationMode,
  resolvePlaybackRate,
  SourceKind,
  type UrlSourceReadConfig,
  VideoEngineError,
  VideoEngineErrorCode,
  type VideoSource,
} from "./types";
import { createEngineWorker } from "./worker-bridge";
import { MirrorStore } from "./mirror-store";
import {
  applyMirrorEvent,
  type AwaitableCommand,
  deserializeEngineError,
  type EngineCommand,
  type EngineEvent,
  type EngineLoadConfig,
  type FireAndForgetCommand,
  isMirrorEvent,
  type PresentedFrame,
  type PresentedFrameEvent,
  type RequestId,
  type ResponseEvent,
  type SerializedViewport,
  type SourceResidencyConfig,
} from "./worker-protocol";

/**
 * Where a caller wants the playhead: a frame of the source, or a position in
 * milliseconds. A pointer only ever has the second kind; anything the engine
 * published carries the first, and handing that back needs no conversion.
 */
export type SeekTarget = number | FrameId;

export interface VideoEngineOptions {
  source: VideoSource;
  /**
   * Who owns the pixels, fixed for the life of the engine. Default "canvas":
   * the engine holds the display canvas bindCanvas transfers to it and paints
   * every frame that earns the screen. Under "frames" it holds no canvas,
   * paints nothing, and hands those frames to onPresentedFrame instead, for a
   * host compositor to draw; bindCanvas then throws.
   */
  presentation?: PresentationMode;
  /**
   * Cache strategy for instant scrub feedback. Default "tiered" keeps a
   * downscaled preview history plus a RAM-bounded full-resolution tier;
   * "none" disables caching (the cursor decodes every seek from scratch).
   */
  cacheStrategy?: "tiered" | "none";
  /** Preview-tier capacity (frames). Ignored when cacheStrategy is "none". */
  previewCapacity?: number;
  /** Preview-tier entry width in CSS pixels. Ignored when cacheStrategy is "none". */
  previewWidth?: number;
  /**
   * Cache lookups whose nearest hit lies within this many milliseconds of
   * what the canvas already shows are rejected, forcing a full-res decode.
   * See constants.FRAME_CACHE.SKIP_NEAR_MS for the default and tuning notes.
   */
  cacheSkipNearMs?: number;
  /**
   * Decides the resolution preview frames decode to. Defaults to native, so a
   * consumer that says nothing keeps full source resolution and pays for it in
   * paint work and frame-cache slots. Governs the live preview only; never the
   * timestamps a consumer extracts.
   *
   * Which strategy fits follows from `presentation`. Under "canvas" the engine
   * measures the box it was handed, so viewportResolution() reads it. Under
   * "frames" nothing binds a canvas and there is no box to read, so
   * viewportResolution() resolves to native there and displayBoxResolution()
   * is how that consumer states the size it composites into.
   */
  decodeStrategy?: DecodeResolutionStrategy;
  /**
   * Pin the 2D renderer instead of WebGPU. WebGPU is the default; leaving this
   * unset prefers it and falls back to the 2D renderer only when WebGPU is
   * unavailable, so unset is not a guarantee of WebGPU. Both renderers paint
   * the same already-decoded frames on the same cadence (the render loop draws
   * a frame only when a new one is decoded). The 2D path is one canvas blit
   * per frame, not a re-decode and not a per-tick CPU repaint; the two differ
   * only in where a frame is composited, the GPU versus a 2D context.
   */
  prefer2d?: boolean;
  /**
   * Hold the source's bytes in this process and serve the demuxer's reads from
   * them, so a position read once is read locally ever after. Off by default:
   * it spends memory the host has to be willing to spend, and prefetching
   * spends the viewer's link on bytes they may never watch.
   *
   * Only a `SourceKind.Url` source can use this. A Blob source is already local
   * and a Stream source is consumed once, so neither has anything to hold.
   */
  sourceResidency?: SourceResidencyConfig;
  /**
   * Read tuning handed to mediabunny for a `SourceKind.Url` source: how many
   * range requests it may run at once, and how many bytes its own reader keeps.
   * Nothing here is read for a Blob or Stream source.
   */
  urlSource?: UrlSourceReadConfig;
}

/**
 * The slice of a Worker this facade depends on. A real Worker is structurally
 * assignable, so production passes one through createEngineWorker; tests
 * pass a fake port that hosts an EngineCore in-process.
 */
export interface EngineWorkerPort {
  postMessage(message: EngineCommand, transfer: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void;
  terminate(): void;
}

/**
 * Main-thread facade for the worker-hosted video engine. Owns the worker
 * (spawned lazily on the first command), the mirror store React reads through
 * useSyncExternalStore, and the imperative handle. The decode + render loop runs
 * in the worker (EngineCore); this class never touches a cursor or clock directly.
 *
 * Three planes cross the worker boundary (see workerProtocol): commands go out,
 * broadcast state comes back as MirrorEvents fed into the store, and the display
 * canvas is transferred once on bindCanvas. Awaitable commands carry a requestId
 * the worker echoes back so each call settles its own promise.
 *
 * Time has two owners, gated by playback. While playing, the worker emits time;
 * while paused, the main thread owns the position: scrub/commit/step write it
 * optimistically so a late worker paint never yanks it back. Consumers render the
 * playhead by reading getTimeMs/getDurationMs at their own cadence.
 *
 * Engine outlives a single React render. Recreate the engine only when the
 * source identity changes.
 */
export class VideoEngine {
  private readonly store = new MirrorStore();
  private readonly diagnosticsStore = new DiagnosticsStore();
  private readonly createWorker: () => EngineWorkerPort;
  private port: EngineWorkerPort | null = null;
  private disposed = false;
  private lastTrace: EngineTrace | null = null;
  private traceArmed = false;
  private readonly pending = new Map<
    RequestId,
    {
      resolve: (response: ResponseEvent) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRequestId: RequestId = 1;
  private metadata: EngineReadySnapshot | null = null;
  /** The loaded source's frame table, held here so a gesture is resolved to a
   *  frame in the tick it arrives, with no worker round trip. */
  private timeline: FrameTimeline | null = null;
  private transferredCanvas: HTMLCanvasElement | null = null;
  private presentedFrameHandler: PresentedFrameHandler | null = null;
  private cachedHandle: VideoEngineHandle | null = null;
  /** WebGPU support is a main-thread fact the worker cannot cheaply probe, so
   *  the facade fills it onto each diagnostics snapshot for the warning rules. */
  private readonly webgpuAvailable =
    typeof navigator !== "undefined" && "gpu" in navigator;

  constructor(
    private readonly options: VideoEngineOptions,
    createWorker: () => EngineWorkerPort = createEngineWorker,
  ) {
    this.createWorker = createWorker;
  }

  async load(): Promise<EngineReadySnapshot> {
    // Reflect Loading synchronously so a freshly mounted surface does not
    // sit on stale Idle until the worker's first status mirror lands.
    this.store.writeStatus(PlaybackStatus.Loading);
    const config: EngineLoadConfig = {
      source: toWorkerSource(this.options.source),
      presentation: this.options.presentation,
      cacheStrategy: this.options.cacheStrategy,
      previewCapacity: this.options.previewCapacity,
      previewWidth: this.options.previewWidth,
      cacheSkipNearMs: this.options.cacheSkipNearMs,
      decodeStrategy: this.options.decodeStrategy,
      prefer2d: this.options.prefer2d,
      sourceResidency: this.options.sourceResidency,
      urlSource: this.options.urlSource,
    };
    try {
      const response = await this.request((requestId) => ({
        type: "load",
        requestId,
        config,
      }));
      if (response.type !== "ready") {
        throw new VideoEngineError(
          VideoEngineErrorCode.BackendCrashed,
          "engine load did not return metadata",
        );
      }
      this.metadata = response.metadata;
      this.timeline = FrameTimeline.from(response.metadata.timeline);
      this.writePlayheadAt(0);
      return this.metadata;
    } catch (cause) {
      const error = toEngineError(cause);
      // Aborted is dispose draining this request, and dispose has already
      // settled the store on Idle. Anything else is a real load failure the
      // surface must be able to render.
      if (error.code !== VideoEngineErrorCode.Aborted) {
        this.store.writeStatus(PlaybackStatus.Errored, error);
      }
      throw error;
    }
  }

  /**
   * Transfers the display canvas to the worker exactly once. The transfer is
   * permanent (it neuters the element's 2D/GPU context), so a repeat call with
   * the same element, or a null detach, is a no-op; the binding lives until
   * dispose terminates the worker. The viewport box is measured here, where
   * layout lives, and shipped so a viewport-aware decode strategy can size the
   * sink worker-side.
   */
  bindCanvas = (el: HTMLCanvasElement | null): void => {
    if (el && this.options.presentation === "frames")
      throw canvasBindingRefused();
    if (!el || el === this.transferredCanvas) return;
    const viewport = this.measureViewport(el);
    const offscreen = el.transferControlToOffscreen();
    this.transferredCanvas = el;
    this.post({ type: "bindCanvas", canvas: offscreen, viewport }, [offscreen]);
  };

  play = async (): Promise<void> => {
    await this.request((requestId) => ({ type: "play", requestId }));
  };

  pause = (): void => {
    this.post({ type: "pause" });
  };

  togglePlayback = (): void => {
    this.post({ type: "togglePlayback" });
  };

  /**
   * Forward playback speed, in media seconds per wall second. Takes effect at
   * once while playing and on the next play while paused; either way it
   * survives pause, seek, interactive-seek, and replay from the end, because
   * it is the clock's slope and none of those touch it.
   *
   * Throws synchronously on a rate outside the supported forward range,
   * including any reverse rate. The refusal has to happen here: the command is
   * fire-and-forget, so a worker-side throw would reach no caller.
   */
  setPlaybackRate = (rate: number): void => {
    const next = resolvePlaybackRate(rate);
    this.store.writeRate(next);
    this.post({ type: "setPlaybackRate", rate: next });
  };

  getPlaybackRate(): number {
    return this.store.getRate();
  }

  /**
   * Fire-and-forget seek: latest-wins, does not await idle. A pointer position
   * is not a frame time and never can be, so it is resolved to the frame
   * covering it before it reaches the store or the worker; the table lives on
   * this thread, so the playhead lands on a frame in the same tick the gesture
   * arrives, with no round trip.
   *
   * intent steers what the cache prepares next. Ignored when cacheStrategy is
   * "none": that backend has no access modes to switch and no prefetch to aim.
   */
  scrub = (target: SeekTarget, intent?: SeekIntent): void => {
    const index = this.snap(target);
    this.writePlayheadAt(index);
    this.post({ type: "scrub", frameIndex: index, intent });
  };

  /**
   * Pause-during-drag entry point. Consumers that handle pointer-driven
   * scrub gestures call this on pointerdown so playback freezes and the
   * decoder is not continuously chasing the cursor; the corresponding
   * endInteractiveSeek call on pointerup resumes play if the engine was
   * playing when the drag started. Matches the way native <video> pauses
   * during the scrub-bar drag and resumes on release.
   */
  beginInteractiveSeek = (): void => {
    this.post({ type: "beginInteractiveSeek" });
  };

  /**
   * Pointerup counterpart to beginInteractiveSeek. Resumes play only if the
   * engine was playing when the drag started; an idle-to-idle drag leaves the
   * engine paused. Resolves once the worker has applied the release.
   */
  endInteractiveSeek = async (): Promise<void> => {
    await this.request((requestId) => ({
      type: "endInteractiveSeek",
      requestId,
    }));
  };

  /**
   * Awaited seek. Resolves after the cursor settles. Use on pointer-up so
   * downstream logic (export, telemetry, marker placement) sees the
   * settled frame.
   */
  commit = async (target: SeekTarget): Promise<void> => {
    const index = this.snap(target);
    this.writePlayheadAt(index);
    const response = await this.request((requestId) => ({
      type: "commit",
      requestId,
      frameIndex: index,
    }));
    // The snap above said which frame was aimed at; the ack says which one
    // the walk reached, and a long GOP can make those differ.
    if (response.type === "ack" && response.landing) {
      this.writePlayhead(response.landing);
    }
  };

  seekToKey = async (target: SeekTarget): Promise<void> => {
    const timeline = this.requireTimeline();
    const index = this.snap(target);
    this.writePlayheadAt(index);
    const response = await this.request((requestId) => ({
      type: "seekToKey",
      requestId,
      timeMs: timeline.timeAt(index) * 1000,
    }));
    if (response.type === "ack" && response.landing) {
      this.writePlayhead(response.landing);
    }
  };

  /**
   * Moves one frame along the source in presentation order. Which frame that
   * is depends on where the walk actually settled, which only the worker
   * knows, so the landing rides back on the ack and is written here, keeping
   * the paused playhead in step with the freshly painted frame.
   */
  private stepChain: Promise<void> = Promise.resolve();

  /**
   * Serialized so concurrent callers (rapid key-repeat, mashed buttons, a
   * programmatic loop) never run overlapping steps that race the cursor's
   * one-shot decode iterator and wedge it. Each call chains after the previous,
   * so every invocation advances exactly one frame from the settled position,
   * on any surface.
   */
  step = (direction: 1 | -1): Promise<void> => {
    const run = (): Promise<void> => this.runStep(direction);
    this.stepChain = this.stepChain.then(run, run);
    return this.stepChain;
  };

  private async runStep(direction: 1 | -1): Promise<void> {
    const response = await this.request((requestId) => ({
      type: "step",
      requestId,
      direction,
    }));
    if (response.type === "ack" && response.landing) {
      this.writePlayhead(response.landing);
    }
  }

  /**
   * Settled iff the engine is between operations. Derived from mirror state
   * rather than the cursor (which lives in the worker): Idle/Loading read as
   * settled, otherwise a live seek is the only thing that unsettles it.
   */
  isIdle(): boolean {
    const status = this.store.getStatus();
    if (status === PlaybackStatus.Idle || status === PlaybackStatus.Loading)
      return true;
    return !this.store.getSeeking();
  }

  getSeeking(): boolean {
    return this.store.getSeeking();
  }

  /** Where the transport has settled: a frame of the source, never a request
   *  and never a clock reading. */
  getPlayhead(): FrameLanding {
    return this.store.getPlayhead();
  }

  getTimeMs(): number {
    return this.store.getPlayhead().mediaTimeS * 1000;
  }
  getDurationMs(): number {
    return this.store.getDurationMs();
  }
  getStatus(): PlaybackStatus {
    return this.store.getStatus();
  }
  getPaintSeq(): PaintSeq {
    return this.store.getPaintSeq();
  }
  getMetadata(): EngineReadySnapshot | null {
    return this.metadata;
  }

  /**
   * Cache hit-rate, scrub-decode latency, and access mode from the worker, or
   * null on the uncached cursor. A round-trip per call; for diagnostics, not
   * the hot path.
   */
  async getStats(): Promise<EngineDiagnostics | null> {
    const response = await this.request((requestId) => ({
      type: "getStats",
      requestId,
    }));
    return response.type === "stats" ? response.stats : null;
  }

  /**
   * Opt-in diagnostics broadcast. Starts the worker's BROADCAST_HZ timer and
   * flips on the per-rAF counters; snapshots arrive on the diag plane and land
   * in the DiagnosticsStore. The instrument calls this on mount and
   * stopDiagnostics on unmount, so a closed panel costs the engine nothing.
   */
  startDiagnostics = (hz: number = DIAGNOSTICS.BROADCAST_HZ): void => {
    this.post({ type: "diagnosticsStart", hz });
  };

  stopDiagnostics = (): void => {
    this.post({ type: "diagnosticsStop" });
  };

  /** Arm the worker trace rings. Fire-and-forget; disarmTrace frees them. */
  armTrace = (windowMs: number): void => {
    this.traceArmed = true;
    this.post({ type: "traceArm", windowMs });
  };

  disarmTrace = (): void => {
    this.traceArmed = false;
    this.post({ type: "traceDisarm" });
  };

  /** The capture rescued from a dispose that landed mid-recording, or null. */
  getLastTrace = (): EngineTrace | null => this.lastTrace;

  /** Awaitable: assembles the worker trace and returns it for download. Null
   *  when nothing was armed. */
  exportTrace = async (): Promise<EngineTrace | null> => {
    const response = await this.request((requestId) => ({
      type: "traceExport",
      requestId,
    }));
    return response.type === "traceExport" ? response.trace : null;
  };

  /**
   * Registers THE consumer of presented frames, in "frames" presentation mode.
   * A second registration replaces the first, so at most one holder exists.
   * The handler owns every frame it is given and must close() it; one left
   * open pins a decoder buffer and stalls the decoder.
   *
   * There is deliberately no counterpart that reports the frame most recently
   * presented. A frame readable apart from the message that carried it can be
   * read at a moment when a newer one has already been handed out, which is
   * the desync this plane is shaped to make impossible.
   */
  onPresentedFrame = (handler: PresentedFrameHandler): void => {
    this.presentedFrameHandler = handler;
  };

  /** Subscribe to diagnostics pushes; fires on every diag broadcast. Separate
   *  from the playback subscribe channels so a diagnostics consumer never wakes
   *  on playback state and vice versa. */
  subscribeDiagnostics = (listener: () => void): (() => void) => {
    return this.diagnosticsStore.subscribe(listener);
  };

  /** Latest broadcast snapshot, or null before the first push. */
  getLatestDiagnostics = (): DiagnosticsSnapshot | null => {
    return this.diagnosticsStore.getSnapshot();
  };

  subscribe(channel: EngineChannel, listener: () => void): () => void {
    return this.store.subscribe(channel, listener);
  }

  /**
   * Tears the engine down: drains pending requests so an in-flight load/commit
   * rejects rather than hanging, and terminates the worker. The dispose ack is
   * awaited first so the worker closes its cursor cleanly before the realm is
   * killed.
   *
   * The engine is inert afterwards. A fire-and-forget command is dropped and an
   * awaitable one rejects with {@link VideoEngineErrorCode.Aborted}; neither
   * starts another worker.
   */
  async dispose(): Promise<void> {
    const port = this.port;
    this.disposed = true;
    if (!port) {
      this.store.writeStatus(PlaybackStatus.Idle);
      return;
    }
    try {
      await this.request((requestId) => ({ type: "dispose", requestId }));
      // Terminating the port takes the rings with it, so an armed capture
      // is pulled out while the worker can still answer.
      if (this.traceArmed) this.lastTrace = await this.exportTrace();
      this.traceArmed = false;
    } catch {
      // Teardown must always complete. A wedged worker that never acks the
      // dispose (or one whose command timeout fires) still gets terminated
      // below; swallow the rejection so dispose never throws.
    } finally {
      port.terminate();
      this.port = null;
      this.rejectAllPending(
        new VideoEngineError(
          VideoEngineErrorCode.Aborted,
          "video engine disposed",
        ),
      );
      this.store.writeStatus(PlaybackStatus.Idle);
    }
  }

  /**
   * Curated subset exposed to React via useImperativeHandle. Cached so the
   * handle keeps a stable identity for the lifetime of the engine (consumers
   * may list it in useEffect deps).
   */
  toHandle(): VideoEngineHandle {
    if (this.cachedHandle) return this.cachedHandle;
    this.cachedHandle = {
      play: this.play,
      pause: this.pause,
      togglePlayback: this.togglePlayback,
      setPlaybackRate: this.setPlaybackRate,
      getPlaybackRate: this.getPlaybackRateBound,
      scrub: this.scrub,
      commit: this.commit,
      seekToKey: this.seekToKey,
      step: this.step,
      beginInteractiveSeek: this.beginInteractiveSeek,
      endInteractiveSeek: this.endInteractiveSeek,
      isIdle: this.isIdleBound,
      getPlayhead: this.getPlayheadBound,
      getTimeMs: this.getTimeMsBound,
      getDurationMs: this.getDurationMsBound,
      getPaintSeq: this.getPaintSeqBound,
      getMetadata: this.getMetadataBound,
      getStats: this.getStatsBound,
      getPlaybackState: this.getPlaybackStateBound,
      getSeeking: this.getSeekingBound,
      bindCanvas: this.bindCanvas,
      onPresentedFrame: this.onPresentedFrame,
      subscribe: this.subscribeBound,
      startDiagnostics: this.startDiagnostics,
      stopDiagnostics: this.stopDiagnostics,
      armTrace: this.armTrace,
      disarmTrace: this.disarmTrace,
      exportTrace: this.exportTrace,
      getLastTrace: this.getLastTrace,
      subscribeDiagnostics: this.subscribeDiagnostics,
      getLatestDiagnostics: this.getLatestDiagnostics,
    };
    return this.cachedHandle;
  }

  // Bound aliases. Arrow methods (play, pause, scrub, ...) are already
  // bound at declaration; these wrap the per-call methods so the handle can
  // hold direct references without `() => this.foo()` re-wrappers.
  private readonly isIdleBound = (): boolean => this.isIdle();
  private readonly getPlayheadBound = (): FrameLanding => this.getPlayhead();
  private readonly getTimeMsBound = (): number => this.getTimeMs();
  private readonly getDurationMsBound = (): number => this.getDurationMs();
  private readonly getPaintSeqBound = (): PaintSeq => this.getPaintSeq();
  private readonly getMetadataBound = (): EngineReadySnapshot | null =>
    this.getMetadata();
  private readonly getStatsBound = (): Promise<EngineDiagnostics | null> =>
    this.getStats();
  private readonly getPlaybackStateBound = (): PlaybackState =>
    this.store.getPlaybackState();
  private readonly getSeekingBound = (): boolean => this.getSeeking();
  private readonly getPlaybackRateBound = (): number => this.getPlaybackRate();
  private readonly subscribeBound = (
    c: EngineChannel,
    l: () => void,
  ): (() => void) => this.subscribe(c, l);

  private readonly onWorkerMessage = (
    event: MessageEvent<EngineEvent>,
  ): void => {
    const data = event.data;
    // The diagnostics plane is routed to its own store before the mirror
    // reducer or the response settler ever see it, so a 10Hz push never
    // enters applyMirrorEvent and never wakes a playback subscriber.
    if (data.type === "diag") {
      this.diagnosticsStore.write({
        ...data.snapshot,
        memory: { jsHeapUsedBytes: readPageHeapBytes() },
        webgpuAvailable: this.webgpuAvailable,
      });
      return;
    }
    if (data.type === "presentedFrame") {
      this.deliverPresentedFrame(data);
      return;
    }
    if (isMirrorEvent(data)) {
      applyMirrorEvent(this.store, data);
      return;
    }
    this.settle(data);
  };

  /**
   * Hands one frame to the registered consumer, which owns it from here. With
   * nobody registered it is closed at once rather than dropped on the floor:
   * the worker has already let go of it, so an unclaimed frame is a leak that
   * pins a decoder buffer.
   */
  private deliverPresentedFrame(event: PresentedFrameEvent): void {
    const handler = this.presentedFrameHandler;
    if (!handler) {
      event.frame.close();
      return;
    }
    handler({
      paintSeq: event.paintSeq,
      frameId: event.frameId,
      mediaTimeS: event.mediaTimeS,
      mediaTimeMs: event.mediaTimeMs,
      quality: event.quality,
      frame: event.frame,
    });
  }

  private settle(response: ResponseEvent): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.type === "error") {
      pending.reject(deserializeEngineError(response.error));
      return;
    }
    pending.resolve(response);
  }

  /**
   * Spawns the worker on first use and wires the state plane into the mirror
   * store. Deferring the spawn keeps construction side-effect-free, so a
   * VideoEngine built during render (e.g. a useState initializer) never leaks
   * a worker when React discards a duplicate.
   */
  private ensurePort(): EngineWorkerPort | null {
    if (this.port) return this.port;
    // A command arriving after teardown must not spawn a replacement worker:
    // nothing would hold it, so nothing would ever terminate it.
    if (this.disposed) return null;
    const port = this.createWorker();
    port.addEventListener("message", this.onWorkerMessage);
    this.port = port;
    return port;
  }

  private request(
    build: (requestId: RequestId) => AwaitableCommand,
  ): Promise<ResponseEvent> {
    const port = this.ensurePort();
    if (!port) {
      return Promise.reject(
        new VideoEngineError(
          VideoEngineErrorCode.Aborted,
          "video engine disposed",
        ),
      );
    }
    const requestId = this.nextRequestId++;
    return new Promise<ResponseEvent>((resolve, reject) => {
      // Backstop a wedged worker: a command whose reply never lands (the
      // worker stuck awaiting a hung decode that even the worker-side
      // watchdog could not recover) would otherwise hang this promise
      // forever, leaving the UI on a permanent spinner. Reject after a
      // generous bound and drop the entry so the caller surfaces an error.
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(
          new VideoEngineError(
            VideoEngineErrorCode.BackendCrashed,
            "video engine command timed out waiting for the worker",
          ),
        );
      }, HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      port.postMessage(build(requestId), []);
    });
  }

  private post(
    command: FireAndForgetCommand,
    transfer: Transferable[] = [],
  ): void {
    this.ensurePort()?.postMessage(command, transfer);
  }

  private rejectAllPending(reason: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  /**
   * The frame a target names.
   *
   * A frame names itself. A millisecond position is narrowed in seconds and
   * then settled against `timeAt(i) * 1000`, the expression getTimeMs
   * publishes: dividing a published millisecond back into seconds re-rounds
   * it, and on tick rates like NTSC's 24000 the quotient can land just under
   * the frame's own second, one frame early.
   */
  private snap(target: SeekTarget): number {
    if (typeof target !== "number") return target.index;
    const timeline = this.requireTimeline();
    const at = timeline.indexAtOrBefore(target / 1000);
    const next = at + 1;
    return next < timeline.frameCount && timeline.timeAt(next) * 1000 <= target
      ? next
      : at;
  }

  private writePlayheadAt(index: number): void {
    this.writePlayhead(this.requireTimeline().landingAt(index));
  }

  private writePlayhead(landing: FrameLanding): void {
    this.store.writePlayhead(landing.frame, landing.mediaTimeS);
  }

  private requireTimeline(): FrameTimeline {
    const timeline = this.timeline;
    if (!timeline) {
      throw new VideoEngineError(
        VideoEngineErrorCode.BackendCrashed,
        "video engine moved before load resolved its frame timeline",
      );
    }
    return timeline;
  }

  private measureViewport(el: HTMLCanvasElement): SerializedViewport {
    const rect = el.getBoundingClientRect();
    return {
      displayWidth: rect.width > 0 ? rect.width : null,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    };
  }
}

/**
 * Spawning the worker can fail outright with a DOMException, so not every
 * throw on the way to a loaded engine arrives as a VideoEngineError.
 */
/**
 * The engine worker is spawned from a Blob object URL, whose base URL is opaque:
 * inside it `new URL("/clip.mp4", self.location.href)` throws and `fetch` on a
 * relative path fails to parse. The facade runs on the page, so it is the last
 * place a relative source URL can be resolved against the document a host means.
 */
function toWorkerSource(source: VideoSource): VideoSource {
  if (source.kind !== SourceKind.Url) return source;
  return {
    ...source,
    url: new URL(source.url, globalThis.location?.href).href,
  };
}

/**
 * Blink exposes performance.memory on Window only, so the worker that assembles
 * the snapshot can never read it and the facade fills it in on receipt. Null off
 * Blink.
 */
function readPageHeapBytes(): number | null {
  const timing = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  return timing.memory?.usedJSHeapSize ?? null;
}

function toEngineError(cause: unknown): VideoEngineError {
  if (cause instanceof VideoEngineError) return cause;
  return new VideoEngineError(
    VideoEngineErrorCode.BackendCrashed,
    cause instanceof Error ? cause.message : String(cause),
    cause,
  );
}

/**
 * Receives one presented frame and owns it: it must close() the VideoFrame, and
 * the identity it is judged against arrives in the same object, never fetched.
 */
export type PresentedFrameHandler = (presented: PresentedFrame) => void;

/**
 * Imperative handle exposed to React via useImperativeHandle. Stable identity
 * for the lifetime of one source, so consumers may list it in effect deps.
 *
 * Curated subset on purpose: coarse status + error are reachable via the
 * PlaybackStateContext or useVideoEngineState hook, NOT through the handle, so a
 * consumer that latches onto the handle does not also depend on the shape of
 * getPlaybackState.
 */
export interface VideoEngineHandle {
  play(): Promise<void>;
  pause(): void;
  togglePlayback(): void;
  /**
   * Forward playback speed in media seconds per wall second, within the range
   * PLAYBACK_RATE bounds. Throws synchronously outside it, reverse included.
   * Subscribe on the "rate" channel to follow it.
   */
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  scrub(target: SeekTarget, intent?: SeekIntent): void;
  commit(target: SeekTarget): Promise<void>;
  seekToKey(target: SeekTarget): Promise<void>;
  step(direction: 1 | -1): Promise<void>;
  /**
   * Pointerdown of a drag-based scrub. Pauses if the engine was playing
   * and remembers to resume on endInteractiveSeek. Idempotent inside a
   * drag (re-entries while the resume flag is armed are no-ops, so the
   * original "was playing" state survives).
   */
  beginInteractiveSeek(): void;
  /** Pointerup of a drag-based scrub. Resumes play iff begin paused us. */
  endInteractiveSeek(): Promise<void>;
  isIdle(): boolean;
  /** Where the transport has settled, as a frame of the source. */
  getPlayhead(): FrameLanding;
  /** The same position on the whole-millisecond plane, for a host that still
   *  speaks it. Handing this value back to scrub, commit or seekToKey lands on
   *  the frame it came from, on every source. */
  getTimeMs(): number;
  getDurationMs(): number;
  getPaintSeq(): PaintSeq;
  getMetadata(): EngineReadySnapshot | null;
  /** Worker-side runtime stats (cache hit-rate, scrub latency, access mode)
   *  for diagnostics; null on the uncached cursor. A round-trip per call. */
  getStats(): Promise<EngineDiagnostics | null>;
  getPlaybackState(): PlaybackState;
  /**
   * True while the cursor is mid-scrub. Cache-hit scrubs do not flip this
   * because the cache paint is synchronous; only real cursor decode walks
   * trip it. Subscribed via the "seeking" channel.
   */
  getSeeking(): boolean;
  bindCanvas(el: HTMLCanvasElement | null): void;
  /**
   * Registers the single consumer of presented frames ("frames" presentation
   * mode). Registering again replaces the previous consumer. The handler owns
   * each frame and must close() it.
   */
  onPresentedFrame(handler: PresentedFrameHandler): void;
  subscribe(channel: EngineChannel, listener: () => void): () => void;
  /**
   * Opt-in diagnostics broadcast control. The instrument starts on mount and
   * stops on unmount (and on visibilitychange), so the worker pays nothing when
   * no panel listens. Snapshots arrive via subscribeDiagnostics; the playback
   * channels are untouched.
   */
  startDiagnostics(hz?: number): void;
  stopDiagnostics(): void;
  /** Arm/disarm the worker trace rings (fire-and-forget). */
  armTrace(windowMs: number): void;
  disarmTrace(): void;
  /** Assemble and return the worker trace for download; null when not armed. */
  exportTrace(): Promise<EngineTrace | null>;
  /** The capture rescued from a dispose that landed mid-recording, or null. */
  getLastTrace(): EngineTrace | null;
  /** Subscribe to diagnostics pushes. Separate from the playback channels. */
  subscribeDiagnostics(listener: () => void): () => void;
  /** Latest broadcast snapshot, or null before the first push. */
  getLatestDiagnostics(): DiagnosticsSnapshot | null;
}
