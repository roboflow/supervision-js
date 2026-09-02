import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { MediaClock } from "./clock";
import * as factoryModule from "./create-scrub-cursor";
import { displayBoxResolution } from "./decode-resolution";
import { EngineCore } from "./engine-core";
import type { Rotation } from "./rotation";
import { ScrubController, setDiagnosticsEnabled } from "./scrub-controller";
import type {
  ScrubFrame,
  ScrubFrameListener,
  VideoSampleLike,
} from "./scrub-cursor";
import { asSec, WebVideoEngineError, WebVideoEngineErrorCode } from "./types";
import { type EngineWorkerPort, WebVideoEngine } from "./video-engine";
import { handleEngineCommand } from "./worker-dispatch";
import type {
  DiagnosticsEvent,
  EngineCommand,
  EngineEvent,
  EngineLoadConfig,
  MirrorEvent,
  PresentedFrame,
  PresentedFrameEvent,
} from "./worker-protocol";
import {
  type FakeCursor,
  FakeClock,
  FakeOffscreenCanvas,
  installWorkerGlobals,
  LOAD_CONFIG,
  makeFakeCursor,
  makeScrubFrame,
} from "../test/fake-engine-deps";

/**
 * The frame-source contract. In "frames" presentation mode the engine paints
 * nothing and holds no canvas: every frame that earns the screen leaves as one
 * message carrying its identity and its pixels together, on the transfer list,
 * with exactly one owner at a time.
 */

// The real bridge spawns a Worker via import.meta.url, which the test runner
// the facade tests inject their own port, so the real factory is never reached.
vi.mock("./worker-bridge", () => ({ createEngineWorker: vi.fn() }));

/** Every VideoFrame the runtime wrapped a canvas in, newest last. */
const wrapped: FakeVideoFrame[] = [];

class FakeVideoFrame {
  closeCount = 0;
  /** Detachment as WebCodecs defines it: a closed frame reports no format.
   *  It is the only thing a holder of the frame can read to tell the two
   *  states apart. */
  format: string | null = "RGBA";

  constructor(
    readonly source: unknown,
    readonly init?: VideoFrameInit,
  ) {
    wrapped.push(this);
  }

  close(): void {
    this.closeCount += 1;
    this.format = null;
  }
}

/** A sample whose draw() is a trap: frames presentation takes a VideoFrame out
 *  of the sample before materializing it, rather than asking the sample to draw
 *  through the canvas-renderer path. */
class FakeSample implements VideoSampleLike {
  closeCount = 0;
  readonly handedOut: FakeVideoFrame[] = [];

  constructor(
    readonly timestamp: number = 0,
    readonly duration: number = 0,
    readonly rotation: Rotation = 0,
  ) {}

  toVideoFrame(): VideoFrame {
    const frame = new FakeVideoFrame("sample");
    this.handedOut.push(frame);
    return frame as unknown as VideoFrame;
  }

  draw(): void {
    throw new Error("frames mode drew a sample into a canvas");
  }

  close(): void {
    this.closeCount += 1;
  }
}

const FRAMES_CONFIG: EngineLoadConfig = {
  ...LOAD_CONFIG,
  presentation: "frames",
};

beforeAll(() => {
  installWorkerGlobals();
  (globalThis as { VideoFrame?: unknown }).VideoFrame = FakeVideoFrame;
});

beforeEach(() => {
  wrapped.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setDiagnosticsEnabled(false);
});

function flushRaf(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function fakeCanvas(): OffscreenCanvas {
  return new FakeOffscreenCanvas(1280, 720) as unknown as OffscreenCanvas;
}

/** Runs `act` expecting the engine to refuse it, and returns the refusal. */
function refusal(act: () => void): WebVideoEngineError {
  try {
    act();
  } catch (error) {
    if (error instanceof WebVideoEngineError) return error;
    throw error;
  }
  throw new Error("expected the canvas to be refused");
}

interface CoreHarness {
  engine: EngineCore;
  events: MirrorEvent[];
  presented: Array<{ event: PresentedFrameEvent; transfer: Transferable[] }>;
  cursor: FakeCursor;
}

function setupCore(
  options: { clock?: MediaClock; wireSink?: boolean } = {},
): CoreHarness {
  const cursor = makeFakeCursor();
  vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
  const events: MirrorEvent[] = [];
  const presented: CoreHarness["presented"] = [];
  const engine = new EngineCore({
    emit: (event) => events.push(event),
    emitPresentedFrame:
      options.wireSink === false
        ? undefined
        : (event, transfer) => presented.push({ event, transfer }),
    clock: options.clock,
  });
  return { engine, events, presented, cursor };
}

describe("EngineCore in frames presentation", () => {
  it("a paint leaves as one message: identity, pixels, and the transfer list", async () => {
    const { engine, events, presented, cursor } = setupCore({
      clock: new FakeClock(),
    });
    await engine.load(FRAMES_CONFIG);

    cursor.emit(asSec(1.5));
    await flushRaf();

    expect(presented).toHaveLength(1);
    const { event, transfer } = presented[0];
    expect(event).toMatchObject({
      type: "presentedFrame",
      paintSeq: 1,
      frameId: { index: 45, ticks: 45000 },
      mediaTimeS: 1.5,
      quality: "exact",
    });
    expect(transfer).toEqual([event.frame]);
    // Transferred, not closed: the receiver is the only owner from here.
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].closeCount).toBe(0);
    // The no-pixels mirror event still fires, so UI mirrors keep working.
    expect(events).toContainEqual({
      type: "frame",
      paintSeq: 1,
      frameId: { index: 45, ticks: 45000 },
      mediaTimeS: 1.5,
      quality: "exact",
    });
    await engine.dispose();
  });

  it("releases a decoder sample after materializing the host frame", async () => {
    const { engine, presented, cursor } = setupCore({ clock: new FakeClock() });
    const sample = new FakeSample(1_500_000);
    await engine.load(FRAMES_CONFIG);

    cursor.emitFrame({
      kind: "sample",
      sample,
      timestampS: asSec(1.5),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();

    expect(presented).toHaveLength(1);
    expect(sample.closeCount).toBe(1);
    await engine.dispose();
  });

  it("advances playback only for a frame the host displayed, not one it discarded", async () => {
    const { engine, events, presented, cursor } = setupCore({
      clock: new FakeClock(),
    });
    const sample = new FakeSample(2_000_000);
    await engine.load(FRAMES_CONFIG);
    events.length = 0;

    cursor.emitFrame({
      kind: "sample",
      sample,
      timestampS: asSec(2),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();

    expect(events.filter((event) => event.type === "playhead")).toEqual([]);
    expect(sample.closeCount).toBe(1);

    engine.play();
    const event = presented[0].event;
    engine.acknowledgePresentedFrame(
      event.paintSeq,
      event.frameId,
      event.navigationGeneration,
    );

    expect(events.filter((event) => event.type === "playhead")).toEqual([
      {
        type: "playhead",
        frameId: { index: 60, ticks: 60000 },
        mediaTimeS: 2,
      },
    ]);
    expect(sample.closeCount).toBe(1);
    await engine.dispose();
  });

  it("steps from a host frame whose display completed just after pause", async () => {
    const clock = new FakeClock();
    const { engine, presented, cursor } = setupCore({ clock });
    await engine.load(FRAMES_CONFIG);

    cursor.emit(asSec(5));
    await flushRaf();
    const first = presented[0].event;
    engine.acknowledgePresentedFrame(
      first.paintSeq,
      first.frameId,
      first.navigationGeneration,
    );

    cursor.emit(asSec(5.2));
    await flushRaf();
    expect(presented.at(-1)?.event.frameId.index).toBe(156);

    // Pause first settles on frame 150. The host's already-queued refresh then
    // makes frame 156 the actual resting picture.
    engine.play();
    clock.seek(6.6);
    engine.pause();
    expect(clock.now()).toBe(5);
    const second = presented[1].event;
    engine.acknowledgePresentedFrame(
      second.paintSeq,
      second.frameId,
      second.navigationGeneration,
    );
    expect(clock.now()).toBe(5.2);

    expect((await engine.step(1))?.frame.index).toBe(157);
    await engine.dispose();
  });

  it("ignores a displayed-frame acknowledgement from before a newer navigation", async () => {
    const clock = new FakeClock();
    const { engine, presented, cursor } = setupCore({ clock });
    await engine.load(FRAMES_CONFIG);

    cursor.emit(asSec(5));
    await flushRaf();
    const stale = presented[0].event;

    engine.scrub(300);
    expect(clock.now()).toBe(10);
    engine.acknowledgePresentedFrame(
      stale.paintSeq,
      stale.frameId,
      stale.navigationGeneration,
    );

    expect(clock.now()).toBe(10);
    await engine.dispose();
  });

  it("a cache-served paint presents too, wrapped at the media time it sits at", async () => {
    const { engine, presented, cursor } = setupCore({ clock: new FakeClock() });
    cursor.peekCached = (): ScrubFrame => makeScrubFrame(1);
    await engine.load(FRAMES_CONFIG);

    engine.scrub(30);

    expect(presented).toHaveLength(1);
    expect(presented[0].event).toMatchObject({
      paintSeq: 1,
      frameId: { index: 30, ticks: 30000 },
      mediaTimeS: 1,
    });
    expect(wrapped[0].init?.timestamp).toBe(1_000_000);
    await engine.dispose();
  });

  it("a frame nobody is wired to receive is closed, never leaked", async () => {
    const { engine, cursor } = setupCore({
      clock: new FakeClock(),
      wireSink: false,
    });
    await engine.load(FRAMES_CONFIG);

    cursor.emit(asSec(0.5));
    await flushRaf();

    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].closeCount).toBe(1);
    await engine.dispose();
  });

  it("closes the frame and rejects the command when host delivery throws", async () => {
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const events: MirrorEvent[] = [];
    const posts: EngineEvent[] = [];
    const engine = new EngineCore({
      emit: (event) => events.push(event),
      emitPresentedFrame: () => {
        throw new DOMException("frame could not be cloned", "DataCloneError");
      },
      clock: new FakeClock(),
    });
    await engine.load(FRAMES_CONFIG);
    const handled = handleEngineCommand(
      engine,
      { type: "commit", requestId: 17, frameIndex: 30 },
      (event) => posts.push(event),
    );

    cursor.emit(asSec(1));
    await flushRaf();
    await handled;

    expect(posts).toEqual([
      {
        type: "error",
        requestId: 17,
        error: {
          code: WebVideoEngineErrorCode.BackendCrashed,
          message: "video frame presentation failed",
        },
      },
    ]);
    expect(wrapped.at(-1)?.closeCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "status", status: "ERRORED" }),
    );
    expect(events.at(-1)).toEqual({ type: "seeking", seeking: false });
    await engine.dispose();
  });

  it("binding a canvas is refused", async () => {
    const { engine } = setupCore({ clock: new FakeClock() });
    await engine.load(FRAMES_CONFIG);

    const error = refusal(() =>
      engine.setCanvas(fakeCanvas(), {
        displayWidth: 1280,
        devicePixelRatio: 1,
      }),
    );

    expect(error.code).toBe(WebVideoEngineErrorCode.PresentationMismatch);
    expect(engine.getStats()?.renderer).toBeNull();
    await engine.dispose();
  });

  it("a canvas bound before load is refused by the load that names the mode", async () => {
    const { engine } = setupCore({ clock: new FakeClock() });
    engine.setCanvas(fakeCanvas(), { displayWidth: 1280, devicePixelRatio: 1 });

    await expect(engine.load(FRAMES_CONFIG)).rejects.toMatchObject({
      code: WebVideoEngineErrorCode.PresentationMismatch,
    });
  });

  it("canvas mode presents nothing", async () => {
    const { engine, presented, cursor } = setupCore({ clock: new FakeClock() });
    await engine.load(LOAD_CONFIG);
    engine.setCanvas(fakeCanvas(), { displayWidth: 1280, devicePixelRatio: 1 });

    cursor.emit(asSec(1.5));
    await flushRaf();

    expect(presented).toEqual([]);
    expect(wrapped).toEqual([]);
    await engine.dispose();
  });
});

/**
 * Every geometry reading the engine can make in this mode comes from the box the
 * host declared on load: nothing here measures a canvas, and the engine has no
 * window of its own to read a device pixel ratio off.
 */
describe("EngineCore diagnostics in frames presentation", () => {
  const DISPLAY_BOX_CONFIG: EngineLoadConfig = {
    ...FRAMES_CONFIG,
    decodeStrategy: displayBoxResolution({
      boxWidth: 320,
      boxHeight: 320,
      devicePixelRatio: 2,
    }),
  };

  it("the snapshot names the presentation, so a null backend is not an unresolved one", async () => {
    vi.useFakeTimers();
    const diags: DiagnosticsEvent[] = [];
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const engine = new EngineCore({
      emit: () => undefined,
      emitDiagnostics: (event) => diags.push(event),
      clock: new FakeClock(),
    });
    await engine.load(FRAMES_CONFIG);
    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    expect(diags[0].snapshot.presentation).toBe("frames");
    expect(diags[0].snapshot.renderer).toBeNull();

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("decodeVsDisplay reads the box the host declared, with no canvas to measure", async () => {
    vi.useFakeTimers();
    const diags: DiagnosticsEvent[] = [];
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const engine = new EngineCore({
      emit: () => undefined,
      emitDiagnostics: (event) => diags.push(event),
      clock: new FakeClock(),
    });
    await engine.load(DISPLAY_BOX_CONFIG);
    engine.diagnosticsStart(10);
    vi.advanceTimersByTime(100);

    // Decode is 1280x720. A 1280x720 picture fitted into a 320x320 box paints
    // 320 CSS px wide, 640 physical at dpr 2, so decode dwarfs display.
    const ratio = diags[0].snapshot.geometry.decodeVsDisplayAreaRatio;
    expect(ratio).toBeCloseTo(2.25, 5);
    // The engine holds no canvas, and the readouts that describe one say so.
    expect(diags[0].snapshot.geometry.boundCanvasWidth).toBeNull();

    engine.diagnosticsStop();
    vi.useRealTimers();
    await engine.dispose();
  });

  it("the trace reports the ratio the host measured rather than a stand-in 1", async () => {
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const engine = new EngineCore({
      emit: () => undefined,
      clock: new FakeClock(),
    });
    await engine.load(DISPLAY_BOX_CONFIG);
    engine.traceArm(60_000);

    expect(engine.traceExport()?.environment.devicePixelRatio).toBe(2);

    await engine.dispose();
  });

  it("the trace reports no ratio when neither side measured one", async () => {
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const engine = new EngineCore({
      emit: () => undefined,
      clock: new FakeClock(),
    });
    await engine.load(FRAMES_CONFIG);
    engine.traceArm(60_000);

    expect(engine.traceExport()?.environment.devicePixelRatio).toBeNull();

    await engine.dispose();
  });
});

describe("ScrubController in frames presentation", () => {
  /** Builds a controller in frames mode and hands back the cursor's listener,
   *  so a test can deliver frame kinds the shared fake cursor does not make. */
  function setupController(): {
    controller: ScrubController;
    deliver: ScrubFrameListener;
    paints: Array<{ frame: ScrubFrame; presented?: VideoFrame | null }>;
  } {
    const cursor = makeFakeCursor();
    const listeners: ScrubFrameListener[] = [];
    cursor.subscribe = (listener: ScrubFrameListener): (() => void) => {
      listeners.push(listener);
      return (): void => undefined;
    };
    const paints: Array<{ frame: ScrubFrame; presented?: VideoFrame | null }> =
      [];
    const controller = new ScrubController({
      cursor,
      clock: new FakeClock(),
      onPaint: (frame, _catchUpMs, presented) =>
        paints.push({ frame, presented }),
      onEnded: () => undefined,
      cacheSkipNearMs: 100,
      presentation: "frames",
    });
    return { controller, deliver: listeners[0], paints };
  }

  it("materializes a sample into an independent frame for the host", async () => {
    const { controller, deliver, paints } = setupController();
    const sample = new FakeSample(500_000);

    deliver({
      kind: "sample",
      sample,
      timestampS: asSec(0.5),
      width: 320,
      height: 180,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();

    expect(paints).toHaveLength(1);
    expect(sample.handedOut).toHaveLength(1);
    expect(wrapped).toHaveLength(2);
    expect(paints[0].presented).toBe(wrapped[1] as unknown as VideoFrame);
    expect(wrapped[1].source).toBeInstanceOf(FakeOffscreenCanvas);
    expect(wrapped[1].init?.timestamp).toBe(500_000);
    // Materialization spends both the sample and its decoder-backed frame. The
    // independently wrapped canvas frame remains owned by the receiver.
    expect(sample.closeCount).toBe(1);
    expect(sample.handedOut[0].closeCount).toBe(1);
    expect(wrapped[1].closeCount).toBe(0);
    controller.dispose();
  });

  it("paint bookkeeping is unchanged with nothing rendering", async () => {
    setDiagnosticsEnabled(true);
    const { controller, deliver } = setupController();

    deliver(makeScrubFrame(0.5, "preview"));
    await flushRaf();

    expect(controller.getLastPaintedMs()).toBe(500);
    expect(controller.getLastPaintedQuality()).toBe("preview");
    expect(controller.getRealtimeStats().paints).toBe(1);
    expect(controller.rendererName()).toBeNull();
    controller.dispose();
  });
});

class FakeWorkerPort implements EngineWorkerPort {
  readonly engine: EngineCore;
  readonly posts: EngineCommand[] = [];
  private listener: ((event: MessageEvent<EngineEvent>) => void) | null = null;

  constructor(clock: MediaClock) {
    this.engine = new EngineCore({
      emit: (event) => this.deliver(event),
      emitPresentedFrame: (event) => this.deliver(event),
      clock,
    });
  }

  postMessage(command: EngineCommand): void {
    this.posts.push(command);
    void handleEngineCommand(this.engine, command, (out) => this.deliver(out));
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void {
    this.listener = listener;
  }

  terminate(): void {}

  private deliver(event: EngineEvent): void {
    this.listener?.({ data: event } as MessageEvent<EngineEvent>);
  }
}

describe("WebVideoEngine in frames presentation", () => {
  function setupFacade(): {
    engine: WebVideoEngine;
    cursor: FakeCursor;
    port: FakeWorkerPort;
  } {
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const clock = new FakeClock();
    const port = new FakeWorkerPort(clock);
    const engine = new WebVideoEngine(
      { source: LOAD_CONFIG.source, presentation: "frames" },
      () => port,
    );
    return { engine, cursor, port };
  }

  it("the registered consumer receives identity and pixels together and owns them", async () => {
    const { engine, cursor } = setupFacade();
    const seen: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => {
      seen.push(presented);
      presented.frame.close();
    });
    await engine.load();

    cursor.emit(asSec(2));
    await flushRaf();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      paintSeq: 1,
      frameId: { index: 60, ticks: 60000 },
      mediaTimeS: 2,
      quality: "exact",
    });
    expect(seen[0].frame).toBe(wrapped[0] as unknown as VideoFrame);
    expect(wrapped[0].closeCount).toBe(1);
    // The mirror channel keeps carrying the pixel-less frame event.
    expect(engine.getPaintSeq()).toBe(1);
    await engine.dispose();
  });

  it("reports display and release as separate host decisions", async () => {
    const { engine, cursor, port } = setupFacade();
    const seen: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => seen.push(presented));
    await engine.load();

    cursor.emit(asSec(2));
    await flushRaf();

    expect(engine.getTimeMs()).toBe(0);
    const acknowledge = vi
      .spyOn(port.engine, "acknowledgePresentedFrame")
      .mockImplementation(() => undefined);
    await engine.play();
    seen[0].acknowledgePresentation();
    expect(engine.getTimeMs()).toBe(2000);
    expect(acknowledge).toHaveBeenCalledWith(1, { index: 60, ticks: 60000 }, 1);
    expect(wrapped[0].closeCount).toBe(0);

    seen[0].frame.close();
    expect(wrapped[0].closeCount).toBe(1);
    await engine.dispose();
  });

  it("a turned track hands the host the turn its pixels still owe", async () => {
    const { engine, cursor } = setupFacade();
    const seen: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => {
      seen.push(presented);
      presented.frame.close();
    });
    await engine.load();

    cursor.emitFrame({
      kind: "sample",
      sample: new FakeSample(2_000_000, 0, 270),
      timestampS: asSec(2),
      width: 720,
      height: 1280,
      isKeyFrame: false,
      quality: "exact",
    });
    await flushRaf();

    expect(seen).toHaveLength(1);
    expect(seen[0].rotation).toBe(270);
    await engine.dispose();
  });

  it("an unturned track hands the host a turn of zero", async () => {
    const { engine, cursor } = setupFacade();
    const seen: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => {
      seen.push(presented);
      presented.frame.close();
    });
    await engine.load();

    cursor.emit(asSec(2));
    await flushRaf();

    expect(seen[0].rotation).toBe(0);
    await engine.dispose();
  });

  it("a second registration replaces the first, so one holder exists", async () => {
    const { engine, cursor } = setupFacade();
    const first: PresentedFrame[] = [];
    const second: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => first.push(presented));
    engine.toHandle().onPresentedFrame((presented) => {
      second.push(presented);
      presented.frame.close();
    });
    await engine.load();

    cursor.emit(asSec(1));
    await flushRaf();

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    await engine.dispose();
  });

  it("an unclaimed frame is closed rather than left pinning a decoder buffer", async () => {
    const { engine, cursor } = setupFacade();
    await engine.load();

    cursor.emit(asSec(1));
    await flushRaf();

    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].closeCount).toBe(1);
    await engine.dispose();
  });

  it("names a handler that keeps the frames it is handed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, cursor } = setupFacade();
    const held: PresentedFrame[] = [];
    engine.toHandle().onPresentedFrame((presented) => held.push(presented));
    await engine.load();

    for (let i = 1; i <= 9; i += 1) {
      cursor.emit(asSec(i));
      await flushRaf();
    }

    expect(held).toHaveLength(9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("onPresentedFrame");
    await engine.dispose();
  });

  it("says nothing to a handler that closes, however long it runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, cursor } = setupFacade();
    engine.toHandle().onPresentedFrame((presented) => presented.frame.close());
    await engine.load();

    for (let i = 1; i <= 20; i += 1) {
      cursor.emit(asSec(i));
      await flushRaf();
    }

    expect(wrapped).toHaveLength(20);
    expect(warn).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it("bindCanvas is refused before anything is transferred", async () => {
    const { engine } = setupFacade();
    await engine.load();

    const error = refusal(() => engine.bindCanvas({} as HTMLCanvasElement));

    expect(error.code).toBe(WebVideoEngineErrorCode.PresentationMismatch);
    await engine.dispose();
  });
});
