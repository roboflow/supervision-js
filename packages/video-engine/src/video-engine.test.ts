import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type { MediaClock } from "./clock";
import { HANG_RECOVERY } from "./constants";
import * as factoryModule from "./create-scrub-cursor";
import { EngineCore } from "./engine-core";
import { FrameTimeline } from "./frame-timeline";
import { setDiagnosticsEnabled } from "./scrub-controller";
import { TRACE_SCHEMA } from "./trace-recorder";
import {
  PlaybackStatus,
  SourceKind,
  WebVideoEngineError,
  WebVideoEngineErrorCode,
  type VideoSource,
} from "./types";
import { WebVideoEngine, type EngineWorkerPort } from "./video-engine";
import { handleEngineCommand } from "./worker-dispatch";
import type { EngineCommand, EngineEvent } from "./worker-protocol";
import {
  type FakeCursor,
  FakeClock,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  replaceProperty,
} from "../test/fake-engine-deps";

/**
 * Facade contract: command in, optimistic store write and/or terminal response
 * out, broadcast state arriving through the mirror channel. The fake port hosts
 * a real EngineCore behind the real dispatcher, wired exactly as
 * videoEngine.worker.ts wires them, so the facade is exercised against its true
 * counterpart minus the MessagePort hop. Routing is synchronous, so a
 * fire-and-forget command (pause, scrub) lands in the store before the call
 * returns and assertions need no extra await.
 */

// The bridge spawns a real Worker; every test injects its own port, so the
// factory behind this mock is never reached.
vi.mock("./worker-bridge", () => ({ createEngineWorker: vi.fn() }));

beforeAll(() => {
  installWorkerGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setDiagnosticsEnabled(false);
});

class FakeWorkerPort implements EngineWorkerPort {
  readonly engine: EngineCore;
  terminated = false;
  /** One entry per posted command, in order, beside its transfer list. */
  readonly commands: EngineCommand[] = [];
  readonly transfers: Transferable[][] = [];
  private listener: ((event: MessageEvent<EngineEvent>) => void) | null = null;

  constructor(clock: MediaClock) {
    this.engine = new EngineCore({
      emit: (event) => this.deliver(event),
      emitDiagnostics: (event) => this.deliver(event),
      clock,
    });
  }

  postMessage(command: EngineCommand, transfer: Transferable[] = []): void {
    this.commands.push(command);
    this.transfers.push(transfer);
    void handleEngineCommand(this.engine, command, (out) => this.deliver(out));
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  private deliver(event: EngineEvent): void {
    this.listener?.({ data: event } as MessageEvent<EngineEvent>);
  }
}

function setup(source: VideoSource = LOAD_CONFIG.source): {
  engine: WebVideoEngine;
  clock: FakeClock;
  cursor: FakeCursor;
  createCursor: MockInstance;
  getPort: () => FakeWorkerPort | null;
} {
  const cursor = makeFakeCursor();
  const createCursor = vi
    .spyOn(factoryModule, "createScrubCursor")
    .mockResolvedValue(cursor);
  const clock = new FakeClock();
  let port: FakeWorkerPort | null = null;
  const engine = new WebVideoEngine({ source }, () => {
    port = new FakeWorkerPort(clock);
    return port;
  });
  return { engine, clock, cursor, createCursor, getPort: () => port };
}

describe("WebVideoEngine", () => {
  it("load returns metadata and broadcasts Loading then Ready", async () => {
    const { engine } = setup();
    const statuses: PlaybackStatus[] = [];
    engine.subscribe("state", () => statuses.push(engine.getStatus()));
    const meta = await engine.load();
    expect(meta.naturalWidth).toBe(1280);
    expect(meta.naturalHeight).toBe(720);
    expect(meta.durationMs).toBe(10000);
    expect(statuses).toEqual([PlaybackStatus.Loading, PlaybackStatus.Ready]);
    expect(engine.getDurationMs()).toBe(10000);
    await engine.dispose();
  });

  it("a failed load rejects with the engine error code preserved", async () => {
    const { engine, createCursor } = setup();
    createCursor.mockRejectedValueOnce(
      new WebVideoEngineError(
        WebVideoEngineErrorCode.DecodeUnsupported,
        "no codec",
      ),
    );
    await expect(engine.load()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.DecodeUnsupported,
      message: "no codec",
    });
    await engine.dispose();
  });

  it("a failed load lands in Errored with the error attached", async () => {
    const { engine, createCursor } = setup();
    createCursor.mockRejectedValueOnce(
      new WebVideoEngineError(
        WebVideoEngineErrorCode.SourceUnreadable,
        "404 fetching source",
      ),
    );
    const statuses: PlaybackStatus[] = [];
    engine.subscribe("state", () => statuses.push(engine.getStatus()));

    await expect(engine.load()).rejects.toThrow("404 fetching source");

    expect(statuses).toEqual([PlaybackStatus.Loading, PlaybackStatus.Errored]);
    const state = engine.toHandle().getPlaybackState();
    expect(state.status).toBe(PlaybackStatus.Errored);
    expect(state.error?.code).toBe(WebVideoEngineErrorCode.SourceUnreadable);
    expect(state.error?.message).toBe("404 fetching source");
    await engine.dispose();
  });

  it("a load retried after a failure clears the error and reaches Ready", async () => {
    const { engine, createCursor } = setup();
    createCursor.mockRejectedValueOnce(
      new WebVideoEngineError(
        WebVideoEngineErrorCode.SourceUnreadable,
        "connection reset",
      ),
    );
    const statuses: PlaybackStatus[] = [];
    engine.subscribe("state", () => statuses.push(engine.getStatus()));

    await expect(engine.load()).rejects.toThrow("connection reset");
    await engine.load();

    expect(statuses).toEqual([
      PlaybackStatus.Loading,
      PlaybackStatus.Errored,
      PlaybackStatus.Loading,
      PlaybackStatus.Ready,
    ]);
    expect(engine.toHandle().getPlaybackState().error).toBeNull();
    await engine.dispose();
  });

  it("a worker that cannot be spawned lands in Errored as a backend crash", async () => {
    const engine = new WebVideoEngine({ source: LOAD_CONFIG.source }, () => {
      throw new Error("Worker construction blocked");
    });

    await expect(engine.load()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.BackendCrashed,
      message: "Worker construction blocked",
    });
    expect(engine.getStatus()).toBe(PlaybackStatus.Errored);
  });

  it("a load aborted by dispose leaves the engine Idle", async () => {
    /** Acks dispose but never answers load, so teardown lands while the
     *  initial load is still in flight. */
    class LoadStallingPort implements EngineWorkerPort {
      private listener: ((event: MessageEvent<EngineEvent>) => void) | null =
        null;
      postMessage(command: EngineCommand): void {
        if (command.type !== "dispose") return;
        this.listener?.({
          data: { type: "ack", requestId: command.requestId },
        } as MessageEvent<EngineEvent>);
      }
      addEventListener(
        _type: "message",
        listener: (event: MessageEvent<EngineEvent>) => void,
      ): void {
        this.listener = listener;
      }
      terminate(): void {}
    }

    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source },
      () => new LoadStallingPort(),
    );
    const pending = engine.load();
    const assertion = expect(pending).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });

    await engine.dispose();
    await assertion;

    expect(engine.getStatus()).toBe(PlaybackStatus.Idle);
  });

  it("dispose rejects an in-flight presented-frame commit through the worker protocol", async () => {
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(
      makeFakeCursor(),
    );
    const ports: FakeWorkerPort[] = [];
    const engine = new WebVideoEngine(
      { presentation: "frames", source: LOAD_CONFIG.source },
      () => {
        const port = new FakeWorkerPort(new FakeClock());
        ports.push(port);
        return port;
      },
    );
    await engine.load();
    const pending = engine.commit(2000);
    const assertion = expect(pending).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });

    await engine.dispose();
    await assertion;

    expect(ports[0]?.terminated).toBe(true);
    expect(engine.getStatus()).toBe(PlaybackStatus.Idle);
  });

  it("play awaits an ack and starts the clock; pause settles synchronously", async () => {
    const { engine, clock } = setup();
    await engine.load();
    await engine.play();
    expect(engine.getStatus()).toBe(PlaybackStatus.Playing);
    expect(clock.playing).toBe(true);
    engine.pause();
    expect(engine.getStatus()).toBe(PlaybackStatus.Paused);
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("togglePlayback alternates the clock", async () => {
    const { engine, clock } = setup();
    await engine.load();
    engine.togglePlayback();
    expect(clock.playing).toBe(true);
    engine.togglePlayback();
    expect(clock.playing).toBe(false);
    await engine.dispose();
  });

  it("a pointer position between two frames lands the playhead on one of them", async () => {
    const { engine, cursor } = setup();
    await engine.load();
    // 1.51s is not a frame of a 30fps source. Frame 45, at 1.5s, covers it.
    engine.scrub(1510);
    expect(engine.getPlayhead()).toEqual({
      frame: { index: 45, ticks: 45000 },
      mediaTimeS: 1.5,
    });
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(1.5);
    await engine.dispose();
  });

  it("every scrub of a drag publishes a frame of the source, not the pointer", async () => {
    const { engine } = setup();
    await engine.load();
    const timeline = FrameTimeline.uniform(30, 1000);
    const ticks = new Set(
      Array.from({ length: timeline.frameCount }, (_, i) =>
        timeline.ticksAt(i),
      ),
    );

    for (let i = 0; i < 2000; i++) {
      engine.scrub(Math.random() * 33000);
      expect(ticks.has(engine.getPlayhead().frame.ticks)).toBe(true);
    }
    await engine.dispose();
  });

  it("commit awaits idle, seeks the cursor, and writes the landing", async () => {
    const { engine, cursor } = setup();
    await engine.load();
    await engine.commit(2000);
    expect(engine.getPlayhead()).toEqual({
      frame: { index: 60, ticks: 60000 },
      mediaTimeS: 2,
    });
    expect(cursor.seekToCalls.at(-1)).toBeCloseTo(2);
    await engine.dispose();
  });

  it("a frame handed back to any transport names itself", async () => {
    const { engine, cursor } = setup();
    await engine.load();
    engine.scrub(1510);
    const frame = engine.getPlayhead().frame;

    for (const restore of [
      (): void => engine.scrub(frame),
      (): Promise<void> => engine.commit(frame),
      (): Promise<void> => engine.seekToKey(frame),
    ]) {
      engine.scrub(0);
      await restore();
      expect(engine.getPlayhead().frame).toEqual(frame);
    }
    // The frame's own second is what reaches the worker; 1510 was only the
    // pointer that found it.
    expect(cursor.seekToKeyCalls.at(-1)).toBe(1.5);
    await engine.dispose();
  });

  it("a published millisecond returns to the frame that published it", async () => {
    const { engine, cursor } = setup();
    // NTSC's grain: 24000 ticks a second, frames 1001 ticks apart. On it a
    // frame can publish a millisecond that does not divide back to the
    // second it was made from; the 30fps default table has no such frame.
    replaceProperty(cursor, "track", {
      ...cursor.track,
      timeline: FrameTimeline.from({
        lastDurationTicks: 1001,
        tickRate: 24000,
        ticks: Float64Array.from({ length: 200 }, (_, index) => index * 1001),
      }),
    });
    await engine.load();

    for (let index = 0; index < 200; index++) {
      engine.scrub(((index * 1001 + 500) / 24000) * 1000);
      expect(engine.getPlayhead().frame.index).toBe(index);
      engine.scrub(engine.getTimeMs());
      expect(engine.getPlayhead().frame.index).toBe(index);
    }
    await engine.dispose();
  });

  it("step writes the frame the ack carries back", async () => {
    const { engine } = setup();
    await engine.load();
    await engine.step(1);
    expect(engine.getPlayhead()).toEqual({
      frame: { index: 1, ticks: 1000 },
      mediaTimeS: 1 / 30,
    });
    await engine.dispose();
  });

  it("step at a boundary leaves the playhead untouched", async () => {
    const { engine } = setup();
    await engine.load();
    const before = engine.getPlayhead();
    await engine.step(-1);
    expect(engine.getPlayhead()).toBe(before);
    await engine.dispose();
  });

  it("two overlapping steps advance exactly two frames, never re-stepping a stale base", async () => {
    const { engine } = setup();
    await engine.load();

    // Fire both without awaiting the first; the chain runs them back to back.
    const a = engine.step(1);
    const b = engine.step(1);
    await Promise.all([a, b]);

    expect(engine.getPlayhead().frame.index).toBe(2);
    await engine.dispose();
  });

  it("dispose acks, closes the cursor, terminates the worker, and goes Idle", async () => {
    const { engine, cursor, getPort } = setup();
    await engine.load();
    await engine.dispose();
    expect(cursor.closed).toBe(true);
    expect(engine.getStatus()).toBe(PlaybackStatus.Idle);
    expect(getPort()?.terminated).toBe(true);
  });

  it("a command arriving after dispose spawns no replacement worker", async () => {
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(
      makeFakeCursor(),
    );
    const clock = new FakeClock();
    const ports: FakeWorkerPort[] = [];
    const engine = new WebVideoEngine({ source: LOAD_CONFIG.source }, () => {
      const port = new FakeWorkerPort(clock);
      ports.push(port);
      return port;
    });
    await engine.load();
    await engine.dispose();

    engine.stopDiagnostics();
    expect(ports).toHaveLength(1);
    expect(ports[0].terminated).toBe(true);
    await expect(engine.play()).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.Aborted,
    });
  });

  describe("command timeout backstop", () => {
    /** A port that accepts commands but never replies, modeling a worker
     *  wedged on a hung decode its own watchdog could not recover. */
    class SilentWorkerPort implements EngineWorkerPort {
      terminated = false;
      postMessage(): void {}
      addEventListener(): void {}
      terminate(): void {
        this.terminated = true;
      }
    }

    it("an awaitable command whose worker never replies rejects and drops its pending entry", async () => {
      vi.useFakeTimers();
      const engine = new WebVideoEngine(
        { source: LOAD_CONFIG.source },
        () => new SilentWorkerPort(),
      );
      const pending = engine.load();
      const assertion = expect(pending).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.BackendCrashed,
      });

      await vi.advanceTimersByTimeAsync(
        HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS,
      );
      await assertion;

      expect(engine.getStatus()).toBe(PlaybackStatus.Errored);
      // The entry is gone, so a late reply (if any) would no-op rather than
      // settle a stale promise. A second command starts a fresh request.
      vi.useRealTimers();
    });
  });

  describe("source handoff", () => {
    const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

    it("a stream load carries the stream itself on the transfer list", async () => {
      const stream = streamOf(new Uint8Array([1, 2, 3]));
      const { engine, getPort } = setup({
        kind: SourceKind.Stream,
        mimeType: "video/mp4",
        stream,
      });

      await engine.load();

      expect(getPort()?.transfers[0]).toEqual([stream]);
      await engine.dispose();
    });

    it("a relative source url is resolved against the page before it is posted", async () => {
      vi.stubGlobal("location", { href: "https://host.test/app/page.html" });
      const { engine, getPort } = setup({
        kind: SourceKind.Url,
        url: "clip.mp4",
      });

      await engine.load();

      const [load] = getPort()?.commands ?? [];
      if (load?.type !== "load" || load.config.source.kind !== SourceKind.Url) {
        throw new Error("the worker received no url load");
      }
      expect(load.config.source.url).toBe("https://host.test/app/clip.mp4");
      await engine.dispose();
    });

    it("a url load transfers nothing", async () => {
      const { engine, getPort } = setup();

      await engine.load();

      expect(getPort()?.transfers[0]).toEqual([]);
      await engine.dispose();
    });

    it("a blob load transfers nothing", async () => {
      const { engine, getPort } = setup({
        kind: SourceKind.Blob,
        blob: new Blob([new Uint8Array([1, 2, 3])]),
      });

      await engine.load();

      expect(getPort()?.transfers[0]).toEqual([]);
      await engine.dispose();
    });

    it("a command the port refuses to post rejects with its timer cleared", async () => {
      vi.useFakeTimers();
      const engine = new WebVideoEngine({ source: LOAD_CONFIG.source }, () => ({
        postMessage(): void {
          throw new DOMException("could not be cloned", "DataCloneError");
        },
        addEventListener(): void {},
        terminate(): void {},
      }));

      await expect(engine.load()).rejects.toMatchObject({
        code: WebVideoEngineErrorCode.BackendCrashed,
        message: "web video engine could not hand the command to the worker",
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(engine.getStatus()).toBe(PlaybackStatus.Errored);
      vi.useRealTimers();
    });

    /**
     * The suite's other ports hand the command object straight to the
     * dispatcher, so nothing there would notice a source that cannot be
     * cloned. This one runs the load over a real MessagePort pair, where the
     * structured clone algorithm decides.
     */
    it("a stream load survives a real structured clone and arrives readable", async () => {
      vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(
        makeFakeCursor(),
      );
      const bytes = new Uint8Array([9, 8, 7, 6]);
      const stream = streamOf(bytes);
      const channel = new MessageChannel();
      const core = new EngineCore({
        emit: (event) => channel.port2.postMessage(event),
        emitDiagnostics: (event) => channel.port2.postMessage(event),
        clock: new FakeClock(),
      });
      const received: EngineCommand[] = [];
      channel.port2.onmessage = (event: MessageEvent<EngineCommand>) => {
        received.push(event.data);
        void handleEngineCommand(core, event.data, (out) =>
          channel.port2.postMessage(out),
        );
      };
      const engine = new WebVideoEngine(
        { source: { kind: SourceKind.Stream, mimeType: "video/mp4", stream } },
        () => ({
          postMessage: (command, transfer) =>
            channel.port1.postMessage(command, transfer),
          addEventListener: (_type, listener) => {
            channel.port1.onmessage = listener;
          },
          terminate: () => {
            channel.port1.close();
            channel.port2.close();
          },
        }),
      );

      await engine.load();

      const [load] = received;
      if (
        load?.type !== "load" ||
        load.config.source.kind !== SourceKind.Stream
      ) {
        throw new Error("the worker received no stream load");
      }
      const arrived = load.config.source.stream;
      expect(arrived).not.toBe(stream);
      expect((await arrived.getReader().read()).value).toEqual(bytes);

      await engine.dispose();
    });
  });

  describe("diagnostics plane", () => {
    it("a diag push lands in the diagnostics store without waking playback", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load();
      const stateListener = vi.fn();
      const timeListener = vi.fn();
      const diagListener = vi.fn();
      engine.subscribe("state", stateListener);
      engine.subscribe("time", timeListener);
      engine.subscribeDiagnostics(diagListener);

      engine.startDiagnostics(10);
      vi.advanceTimersByTime(150);

      expect(diagListener).toHaveBeenCalled();
      expect(engine.getLatestDiagnostics()).not.toBeNull();
      // The diag plane never enters the mirror reducer, so no playback
      // subscriber woke from the broadcast.
      expect(stateListener).not.toHaveBeenCalled();
      expect(timeListener).not.toHaveBeenCalled();

      engine.stopDiagnostics();
      vi.useRealTimers();
      await engine.dispose();
    });

    it("startDiagnostics and stopDiagnostics drive the worker timer", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load();
      const diagListener = vi.fn();
      engine.subscribeDiagnostics(diagListener);

      engine.startDiagnostics(10);
      vi.advanceTimersByTime(100);
      const afterStart = diagListener.mock.calls.length;
      expect(afterStart).toBeGreaterThanOrEqual(1);

      engine.stopDiagnostics();
      vi.advanceTimersByTime(300);
      expect(diagListener.mock.calls.length).toBe(afterStart);

      vi.useRealTimers();
      await engine.dispose();
    });

    it("armTrace then exportTrace returns the assembled worker trace", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load();
      engine.armTrace(60000);
      engine.startDiagnostics(10);
      vi.advanceTimersByTime(100);
      vi.useRealTimers();

      const trace = await engine.exportTrace();
      expect(trace?.schema).toBe(TRACE_SCHEMA);
      expect(trace?.snapshots.length).toBeGreaterThanOrEqual(1);

      engine.stopDiagnostics();
      await engine.dispose();
    });

    it("a dispose that lands mid-capture rescues the trace, marked truncated", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load();
      engine.armTrace(60000);
      engine.startDiagnostics(10);
      vi.advanceTimersByTime(100);
      vi.useRealTimers();

      await engine.dispose();

      const rescued = engine.getLastTrace();
      expect(rescued?.schema).toBe(TRACE_SCHEMA);
      expect(rescued?.snapshots.length).toBeGreaterThanOrEqual(1);
      expect(rescued?.truncatedReason).toBe(
        "engine disposed while the capture was armed",
      );
    });

    it("the snapshot the facade exposes carries main-side webgpuAvailable", async () => {
      vi.useFakeTimers();
      const { engine } = setup();
      await engine.load();
      engine.startDiagnostics(10);
      vi.advanceTimersByTime(100);

      const snapshot = engine.getLatestDiagnostics();
      expect(snapshot).not.toBeNull();
      // Filled main-side; this realm's navigator has no gpu, so false here,
      // but the field is present and boolean.
      expect(typeof snapshot?.webgpuAvailable).toBe("boolean");

      engine.stopDiagnostics();
      vi.useRealTimers();
      await engine.dispose();
    });
  });
});

describe("WebVideoEngine page heap", () => {
  const USED_JS_HEAP_BYTES = 7_113_863;

  it("the facade fills in the heap the worker realm cannot read", async () => {
    vi.useFakeTimers();
    // Blink exposes performance.memory on Window only and this realm has none,
    // so the reading is installed here. After the swap fake timers make: they
    // replace the whole performance object, discarding anything put on the one
    // before it.
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: USED_JS_HEAP_BYTES },
    });
    const { engine } = setup();
    await engine.load();
    engine.armTrace(60000);
    engine.startDiagnostics(10);
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    expect(engine.getLatestDiagnostics()?.memory.jsHeapUsedBytes).toBe(
      USED_JS_HEAP_BYTES,
    );
    // The trace is assembled inside the worker, which never sees the reading,
    // so it says n/a rather than carrying a number from the wrong realm.
    const trace = await engine.exportTrace();
    expect(trace?.snapshots[0].memory.jsHeapUsedBytes).toBeNull();

    engine.stopDiagnostics();
    await engine.dispose();
  });
});

describe("WebVideoEngine playback rate", () => {
  it("setPlaybackRate reaches the worker clock and wakes the rate channel once", async () => {
    const { engine, clock } = setup();
    await engine.load();
    const rates: number[] = [];
    engine.subscribe("rate", () => rates.push(engine.getPlaybackRate()));

    engine.setPlaybackRate(2);

    expect(clock.rate).toBe(2);
    expect(engine.getPlaybackRate()).toBe(2);
    // The facade writes optimistically and the worker mirrors the same value
    // back; the store's write-on-change is what keeps that one emit.
    expect(rates).toEqual([2]);
    await engine.dispose();
  });

  it("the default rate is 1 and the rate channel stays quiet until it changes", async () => {
    const { engine } = setup();
    await engine.load();
    const wakes: number[] = [];
    engine.subscribe("rate", () => wakes.push(engine.getPlaybackRate()));
    expect(engine.getPlaybackRate()).toBe(1);

    engine.play();
    engine.pause();
    engine.scrub(1000);
    expect(wakes).toEqual([]);
    await engine.dispose();
  });

  it.each([0, -1, 12])(
    "a rate of %p throws before anything reaches the worker",
    async (rate) => {
      const { engine, clock } = setup();
      await engine.load();
      expect(() => engine.setPlaybackRate(rate)).toThrow(
        expect.objectContaining({
          code: WebVideoEngineErrorCode.RateUnsupported,
        }),
      );
      expect(clock.rate).toBe(1);
      expect(engine.getPlaybackRate()).toBe(1);
      await engine.dispose();
    },
  );

  it("the handle exposes the rate and reads back what was set", async () => {
    const { engine, clock } = setup();
    await engine.load();
    const handle = engine.toHandle();
    handle.setPlaybackRate(0.25);
    expect(handle.getPlaybackRate()).toBe(0.25);
    expect(clock.rate).toBe(0.25);
    await engine.dispose();
  });

  it("the rate outlives an interactive-seek gesture driven through the facade", async () => {
    const { engine, clock } = setup();
    await engine.load();
    engine.setPlaybackRate(2);
    await engine.play();
    engine.beginInteractiveSeek();
    engine.scrub(3000);
    await engine.endInteractiveSeek();

    expect(clock.playing).toBe(true);
    expect(clock.rate).toBe(2);
    expect(engine.getPlaybackRate()).toBe(2);
    await engine.dispose();
  });
});
