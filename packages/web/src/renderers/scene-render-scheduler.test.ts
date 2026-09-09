import { afterEach, describe, expect, it, vi } from "vitest";

import { createSceneRenderScheduler } from "./scene-render-scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scene render scheduler", () => {
  it("holds still under notifications that describe what is already drawn", () => {
    const draw = vi.fn();
    const scheduler = createSceneRenderScheduler(draw);
    const selection = { detectionIndex: 2 };

    scheduler.renderOnChange([1.5, "contain", selection]);
    scheduler.renderOnChange([1.5, "contain", selection]);
    scheduler.renderOnChange([1.5, "contain", selection]);

    expect(scheduler.getRenderCount()).toBe(1);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("renders once per value that actually changed", () => {
    const scheduler = createSceneRenderScheduler(() => undefined);

    scheduler.renderOnChange([0.5]);
    scheduler.renderOnChange([0.75]);
    scheduler.renderOnChange([0.5]);
    scheduler.renderOnChange([0.5]);

    expect(scheduler.getRenderCount()).toBe(3);
  });

  it("renders nothing on its own while nobody notifies it", () => {
    vi.useFakeTimers();
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const draw = vi.fn();
    const scheduler = createSceneRenderScheduler(draw);

    scheduler.renderOnChange(["paused", 0, 0]);
    vi.advanceTimersByTime(10_000);

    expect(scheduler.getRenderCount()).toBe(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders pixels that changed outside the description", () => {
    const scheduler = createSceneRenderScheduler(() => undefined);

    scheduler.render([1]);
    scheduler.render([1]);

    expect(scheduler.getRenderCount()).toBe(2);
  });
});
