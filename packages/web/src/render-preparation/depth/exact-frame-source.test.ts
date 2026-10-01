import type { DepthMap } from "supervision-js-core";
import { describe, expect, it } from "vitest";

import { createExactDepthFrameSource } from "./exact-frame-source";

function map(index: number): DepthMap {
  return {
    height: 1,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 1,
      values: Uint16Array.of(index),
    },
    width: 1,
  };
}

/** Loads that finish when the test says, in any order. */
function deferredLoads() {
  const pending = new Map<number, (value: DepthMap) => void>();
  const started: number[] = [];
  const aborted: number[] = [];

  return {
    aborted,
    finish(index: number) {
      pending.get(index)?.(map(index));
      pending.delete(index);
    },
    load: (index: number, signal: AbortSignal) =>
      new Promise<DepthMap>((resolve) => {
        started.push(index);
        pending.set(index, resolve);
        signal.addEventListener("abort", () => aborted.push(index));
      }),
    started,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("exact depth frame source", () => {
  it("loads as many frames at once as asked, and hands them over in order", async () => {
    const loads = deferredLoads();
    const source = createExactDepthFrameSource({
      concurrency: () => 3,
      frameCount: 10,
      load: loads.load,
    });
    const run = source.decode(4, {});
    const first = run.next();

    expect(loads.started).toEqual([4, 5, 6]);
    loads.finish(6);
    loads.finish(5);
    await tick();
    loads.finish(4);

    expect(await first).toMatchObject({ index: 4 });
    // Handing one over starts the next.
    expect(loads.started).toEqual([4, 5, 6, 7]);
    expect(await run.next()).toMatchObject({ index: 5 });
    expect(await run.next()).toMatchObject({ index: 6 });
  });

  it("starts at any frame and skips the frames it is told not to keep", async () => {
    const loads = deferredLoads();
    const source = createExactDepthFrameSource({
      concurrency: () => 2,
      frameCount: 10,
      load: loads.load,
    });

    expect(source.randomAccess).toBe(true);
    expect(source.keyIndexAtOrBefore(7)).toBe(7);

    const run = source.decode(2, { keep: (index) => index % 2 === 0 });
    const next = run.next();

    expect(loads.started).toEqual([2, 4]);
    loads.finish(2);
    expect(await next).toMatchObject({ index: 2 });
  });

  it("ends at the last frame, and a cancel aborts the loads in flight", async () => {
    const loads = deferredLoads();
    const source = createExactDepthFrameSource({
      concurrency: () => 2,
      frameCount: 3,
      load: loads.load,
    });
    const run = source.decode(2, {});
    const next = run.next();

    loads.finish(2);
    expect(await next).toMatchObject({ index: 2 });
    expect(await run.next()).toBeNull();

    const other = source.decode(0, {});
    const pending = other.next();

    other.cancel();
    expect(loads.aborted).toEqual([0, 1]);
    loads.finish(0);
    expect(await pending).toBeNull();
  });

  it("measures frames loaded per second of loading", async () => {
    let clock = 0;
    const loads = deferredLoads();
    const source = createExactDepthFrameSource({
      concurrency: () => 2,
      frameCount: 10,
      load: loads.load,
      now: () => clock,
    });
    const run = source.decode(0, {});

    expect(source.loadRate()).toBeNull();
    const first = run.next();

    clock = 100;
    loads.finish(0);
    await first;
    const second = run.next();

    clock = 150;
    loads.finish(1);
    await second;

    // Two loads 50 ms of loading apart: 20 frames a second.
    expect(source.loadRate()).toBeCloseTo(20);
    expect(source.meanLoadMs()).toBeCloseTo(125);
  });
});
