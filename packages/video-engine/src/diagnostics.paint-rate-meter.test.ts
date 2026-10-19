import { describe, expect, it } from "vitest";

import { PaintRateMeter, PresentedRateMeter } from "./diagnostics";

describe("PaintRateMeter", () => {
  it("null until two playing samples span the window", () => {
    const meter = new PaintRateMeter();
    expect(meter.sample(0, 0, true)).toBeNull();
    expect(meter.sample(100, 3, true)).toBeCloseTo(30);
  });

  it("rates over the trailing window, not the whole capture", () => {
    const meter = new PaintRateMeter(3);
    meter.sample(0, 0, true);
    meter.sample(100, 3, true);
    meter.sample(200, 6, true);
    // The window holds the last 3 samples; the slow stretch that follows
    // must show as a lower reading instead of being averaged away.
    expect(meter.sample(300, 7, true)).toBeCloseTo(((7 - 3) / 200) * 1000);
    expect(meter.sample(400, 7, true)).toBeCloseTo(((7 - 6) / 200) * 1000);
  });

  it("a pause invalidates the window, not just the sample", () => {
    const meter = new PaintRateMeter();
    meter.sample(0, 0, true);
    meter.sample(100, 3, true);
    expect(meter.sample(200, 3, false)).toBeNull();
    // One playing sample after the pause is not yet a window.
    expect(meter.sample(300, 4, true)).toBeNull();
    expect(meter.sample(400, 7, true)).toBeCloseTo(30);
  });

  it("a paints reset (new play session) invalidates the window", () => {
    const meter = new PaintRateMeter();
    meter.sample(0, 100, true);
    meter.sample(100, 103, true);
    // The counter restarted below the last reading: a delta across it would
    // read as a huge negative rate.
    expect(meter.sample(200, 1, true)).toBeNull();
    expect(meter.sample(300, 4, true)).toBeCloseTo(30);
  });
});

describe("PresentedRateMeter", () => {
  it("reads the media distance the picture actually travelled per wall second", () => {
    const meter = new PresentedRateMeter();
    expect(meter.sample(0, 0, true)).toBeNull();
    // 2000ms of media painted across 1000ms of wall: 2x, as commanded.
    expect(meter.sample(1000, 2000, true)).toBeCloseTo(2);
  });

  it("reports the shortfall when the picture cannot keep up with the rate", () => {
    const meter = new PresentedRateMeter();
    meter.sample(0, 0, true);
    // Commanded 4x would need 4000ms of media per wall second; 1500 arrived.
    expect(meter.sample(1000, 1500, true)).toBeCloseTo(1.5);
  });

  it("a pause invalidates the window rather than measuring across it", () => {
    const meter = new PresentedRateMeter();
    meter.sample(0, 0, true);
    expect(meter.sample(100, 100, false)).toBeNull();
    expect(meter.sample(200, 200, true)).toBeNull();
    expect(meter.sample(300, 400, true)).toBeCloseTo(2);
  });

  it("a backward jump invalidates the window instead of reporting a negative rate", () => {
    const meter = new PresentedRateMeter();
    meter.sample(0, 5000, true);
    meter.sample(100, 5100, true);
    expect(meter.sample(200, 0, true)).toBeNull();
  });

  it("reset drops the window so a rate change is not measured across its own edge", () => {
    const meter = new PresentedRateMeter();
    meter.sample(0, 0, true);
    meter.sample(1000, 1000, true);
    meter.reset();
    expect(meter.sample(2000, 2000, true)).toBeNull();
    expect(meter.sample(3000, 6000, true)).toBeCloseTo(4);
  });

  it("null before the first paint, so an unpainted session reports nothing", () => {
    const meter = new PresentedRateMeter();
    expect(meter.sample(0, null, true)).toBeNull();
    expect(meter.sample(100, null, true)).toBeNull();
  });
});
