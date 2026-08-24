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
import { ScrubController, setDiagnosticsEnabled } from "./scrub-controller";
import type {
  ScrubFrame,
  ScrubFrameListener,
  VideoSampleLike,
} from "./scrub-cursor";
import { asSec, VideoEngineError, VideoEngineErrorCode } from "./types";
import { type EngineWorkerPort, VideoEngine } from "./video-engine";
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

  constructor(
    readonly source: unknown,
    readonly init?: VideoFrameInit,
  ) {
    wrapped.push(this);
  }

  close(): void {
    this.closeCount += 1;
  }
}

/** A sample whose draw() is a trap: reaching it would mean the frames path went
 *  through a canvas instead of taking the frame straight out of the sample. */
class FakeSample implements VideoSampleLike {
  closeCount = 0;
  readonly handedOut: FakeVideoFrame[] = [];

  constructor(
    readonly timestamp: number = 0,
    readonly duration: number = 0,
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
function refusal(act: () => void): VideoEngineError {
  try {
    act();
  } catch (error) {
    if (error instanceof VideoEngineError) return error;
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

  it("binding a canvas is refused", async () => {
    const { engine } = setupCore({ clock: new FakeClock() });
    await engine.load(FRAMES_CONFIG);

    const error = refusal(() =>
      engine.setCanvas(fakeCanvas(), {
        displayWidth: 1280,
        devicePixelRatio: 1,
      }),
    );

    expect(error.code).toBe(VideoEngineErrorCode.PresentationMismatch);
    expect(engine.getStats()?.renderer).toBeNull();
    await engine.dispose();
  });

  it("a canvas bound before load is refused by the load that names the mode", async () => {
    const { engine } = setupCore({ clock: new FakeClock() });
    engine.setCanvas(fakeCanvas(), { displayWidth: 1280, devicePixelRatio: 1 });

    await expect(engine.load(FRAMES_CONFIG)).rejects.toMatchObject({
      code: VideoEngineErrorCode.PresentationMismatch,
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

  it("a sample hands over its own frame, with no detour through a canvas", async () => {
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
    expect(paints[0].presented).toBe(sample.handedOut[0]);
    // The sample is spent, but the frame taken out of it is a separate
    // reference the receiver still owns.
    expect(sample.closeCount).toBe(1);
    expect(sample.handedOut[0].closeCount).toBe(0);
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
  private listener: ((event: MessageEvent<EngineEvent>) => void) | null = null;

  constructor(clock: MediaClock) {
    this.engine = new EngineCore({
      emit: (event) => this.deliver(event),
      emitPresentedFrame: (event) => this.deliver(event),
      clock,
    });
  }

  postMessage(command: EngineCommand): void {
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

describe("VideoEngine in frames presentation", () => {
  function setupFacade(): { engine: VideoEngine; cursor: FakeCursor } {
    const cursor = makeFakeCursor();
    vi.spyOn(factoryModule, "createScrubCursor").mockResolvedValue(cursor);
    const clock = new FakeClock();
    const engine = new VideoEngine(
      { source: LOAD_CONFIG.source, presentation: "frames" },
      () => new FakeWorkerPort(clock),
    );
    return { engine, cursor };
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

  it("bindCanvas is refused before anything is transferred", async () => {
    const { engine } = setupFacade();
    await engine.load();

    const error = refusal(() => engine.bindCanvas({} as HTMLCanvasElement));

    expect(error.code).toBe(VideoEngineErrorCode.PresentationMismatch);
    await engine.dispose();
  });
});
