import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MediaRendererState,
  RenderPreparationDiagnostics,
} from "supervision";
import {
  clearLiveReadouts,
  publishLiveRenderPreparation,
  publishLiveRendererState,
  readLiveReadouts,
  subscribeLiveReadouts,
} from "./live-readouts";

const frames: (() => void)[] = [];
/* The store keeps the clock reading of its last write across tests, as a real
 * monotonic clock would, so each test starts well past the one before it. */
let nowMs = 0;

function runFrame() {
  const pending = frames.splice(0, frames.length);

  for (const frame of pending) {
    frame();
  }
}

function advance(ms: number) {
  nowMs += ms;
  runFrame();
}

function rendererState(currentTime: number) {
  return {
    activeDetectionFrameTime: currentTime,
    currentTime,
    detectionBuffer: null,
    duration: 10,
    playbackRate: 1,
    playbackState: "playing",
    source: { estimatedFrameRate: 30 },
  } as unknown as MediaRendererState;
}

const diagnostics = {
  artifacts: [],
} as unknown as RenderPreparationDiagnostics;

describe("live readouts", () => {
  beforeEach(() => {
    nowMs += 100_000;
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (frame: () => void) => {
      frames.push(frame);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames.length = 0;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    clearLiveReadouts();
    runFrame();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes every subscriber once for a burst of reports", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeLiveReadouts(first);
    const stopSecond = subscribeLiveReadouts(second);

    first.mockClear();
    second.mockClear();
    advance(1000);

    publishLiveRendererState(rendererState(1), null);
    publishLiveRendererState(rendererState(2), null);
    publishLiveRendererState(rendererState(3), null);
    runFrame();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0].currentTime).toBe(3);

    stopFirst();
    stopSecond();
  });

  it("holds a moving report to the moving cadence", () => {
    const write = vi.fn();
    const stop = subscribeLiveReadouts(write);

    advance(1000);
    publishLiveRendererState(rendererState(1), null);
    runFrame();
    write.mockClear();

    publishLiveRendererState(rendererState(2), null);
    advance(16);
    expect(write).not.toHaveBeenCalled();

    advance(16);
    expect(write).not.toHaveBeenCalled();

    advance(80);
    expect(write).toHaveBeenCalledTimes(1);

    stop();
  });

  it("holds background work to the slower cadence", () => {
    const write = vi.fn();
    const stop = subscribeLiveReadouts(write);

    advance(1000);
    publishLiveRenderPreparation(diagnostics);
    runFrame();
    write.mockClear();

    publishLiveRenderPreparation(diagnostics);
    advance(100);
    expect(write).not.toHaveBeenCalled();

    advance(160);
    expect(write).toHaveBeenCalledTimes(1);

    stop();
  });

  /* A cook filling behind a stopped picture must not hold the picture's own
   * readings back when it starts moving again. */
  it("lets a moving report overtake a waiting background report", () => {
    const write = vi.fn();
    const stop = subscribeLiveReadouts(write);

    advance(1000);
    publishLiveRenderPreparation(diagnostics);
    runFrame();
    write.mockClear();

    publishLiveRenderPreparation(diagnostics);
    advance(120);
    expect(write).not.toHaveBeenCalled();

    publishLiveRendererState(rendererState(4), null);
    runFrame();
    expect(write).toHaveBeenCalledTimes(1);
    expect(readLiveReadouts().currentTime).toBe(4);

    stop();
  });

  it("stops writing when nothing new is published", () => {
    const write = vi.fn();
    const stop = subscribeLiveReadouts(write);

    advance(1000);
    publishLiveRendererState(rendererState(5), null);
    runFrame();
    write.mockClear();

    advance(1000);
    advance(1000);
    expect(write).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);

    stop();
  });
});
