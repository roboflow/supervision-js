import { describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTICS,
  TRACE_RING_BOUNDS,
  type DiagnosticsSnapshot,
} from "supervision-js-web-video-engine";
import type { MediaRendererSource } from "supervision";
import {
  createEngineDiagnosticsTap,
  type EngineDiagnosticsTap,
} from "./engine-diagnostics-tap";

interface FakeEngine {
  readonly armed: number[];
  broadcast(): void;
  readonly disarms: number;
  readonly listeners: number;
  readonly starts: number[];
  readonly stops: number;
  snapshot: DiagnosticsSnapshot | null;
}

function createFakeEngine(): FakeEngine {
  const listeners = new Set<() => void>();
  const armed: number[] = [];
  const starts: number[] = [];
  let disarms = 0;
  let stops = 0;

  const engine = {
    armTrace(windowMs: number) {
      armed.push(windowMs);
    },
    disarmTrace() {
      disarms += 1;
    },
    exportTrace: async () => ({ schema: "video-trace" }),
    getLatestDiagnostics: () => engine.snapshot,
    startDiagnostics(hz?: number) {
      starts.push(hz ?? 0);
    },
    stopDiagnostics() {
      stops += 1;
    },
    subscribeDiagnostics(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    broadcast() {
      for (const listener of listeners) listener();
    },
    snapshot: null as DiagnosticsSnapshot | null,
    get armed() {
      return armed;
    },
    get disarms() {
      return disarms;
    },
    get listeners() {
      return listeners.size;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
  };

  return engine;
}

async function openTapped(tap: EngineDiagnosticsTap, engine: unknown) {
  const source: MediaRendererSource = {
    open: async () =>
      ({ engine }) as unknown as Awaited<
        ReturnType<MediaRendererSource["open"]>
      >,
  };

  await tap.tap(source).open();
}

describe("createEngineDiagnosticsTap", () => {
  it("reads nothing until a video engine source opens", async () => {
    const tap = createEngineDiagnosticsTap();

    expect(tap.read()).toBeNull();

    await openTapped(tap, { open: vi.fn() });

    expect(tap.read()).toBeNull();
  });

  it("holds one broadcast open across overlapping readers", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    await openTapped(tap, engine);

    const first = tap.start();
    const second = tap.start();

    expect(engine.starts).toEqual([DIAGNOSTICS.BROADCAST_HZ]);
    expect(engine.listeners).toBe(1);

    first();

    expect(engine.stops).toBe(0);

    second();

    expect(engine.stops).toBe(1);
    expect(engine.listeners).toBe(0);
  });

  it("starts the broadcast when a source opens under a waiting reader", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    const listener = vi.fn();
    tap.subscribe(listener);
    tap.start();

    await openTapped(tap, engine);

    expect(engine.starts).toEqual([DIAGNOSTICS.BROADCAST_HZ]);

    engine.snapshot = { status: "PLAYING" } as DiagnosticsSnapshot;
    engine.broadcast();

    expect(tap.read()).toBe(engine.snapshot);
    expect(listener).toHaveBeenCalled();
  });

  it("moves the broadcast to the engine of the source that opened last", async () => {
    const first = createFakeEngine();
    const second = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    tap.start();
    await openTapped(tap, first);

    await openTapped(tap, second);

    expect(first.stops).toBe(1);
    expect(first.listeners).toBe(0);
    expect(second.starts).toEqual([DIAGNOSTICS.BROADCAST_HZ]);
  });

  it("reports an open engine whether or not anything is reading it", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();

    expect(tap.attached()).toBe(false);

    await openTapped(tap, engine);

    expect(tap.attached()).toBe(true);
    expect(engine.starts).toEqual([]);
  });

  /* One reading, and the worker goes quiet again: the panel that asks for it
   * shows every figure the engine reports without the broadcast, the per-frame
   * counters and the keyframe walk running behind it for the whole session. */
  it("closes the broadcast again once a single reading has landed", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    await openTapped(tap, engine);

    const reading = vi.fn();
    tap.readOnce(reading);

    expect(engine.starts).toEqual([DIAGNOSTICS.BROADCAST_HZ]);
    expect(engine.stops).toBe(0);

    engine.snapshot = { status: "PLAYING" } as DiagnosticsSnapshot;
    engine.broadcast();

    expect(engine.stops).toBe(1);
    expect(engine.listeners).toBe(0);
    expect(reading).toHaveBeenCalledExactlyOnceWith(engine.snapshot);

    engine.broadcast();

    expect(engine.stops).toBe(1);
  });

  it("holds a single reading open until a push carries one", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    await openTapped(tap, engine);

    const reading = vi.fn();
    tap.readOnce(reading);
    engine.broadcast();

    expect(engine.stops).toBe(0);
    expect(reading).not.toHaveBeenCalled();

    engine.snapshot = { status: "PAUSED" } as DiagnosticsSnapshot;
    engine.broadcast();

    expect(engine.stops).toBe(1);
  });

  it("abandons a reading that is still waiting", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    await openTapped(tap, engine);

    const abandon = tap.readOnce(vi.fn());
    abandon();

    expect(engine.stops).toBe(1);
    expect(engine.listeners).toBe(0);
  });

  it("arms the trace over the window the engine's own rings keep", async () => {
    const engine = createFakeEngine();
    const tap = createEngineDiagnosticsTap();
    await openTapped(tap, engine);

    tap.armTrace();
    tap.disarmTrace();

    expect(engine.armed).toEqual([TRACE_RING_BOUNDS.snapshotWindowMs]);
    expect(engine.disarms).toBe(1);
    await expect(tap.exportTrace()).resolves.toEqual({
      schema: "video-trace",
    });
  });

  it("exports nothing before a source opens", async () => {
    const tap = createEngineDiagnosticsTap();

    await expect(tap.exportTrace()).resolves.toBeNull();
  });
});
