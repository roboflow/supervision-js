import type { ActiveDepthMap, DepthMap, MediaRenderer } from "supervision";
import { describe, expect, it, vi } from "vitest";

import { createDepthProbe } from "./depth-probe";

/** A 2x1 disparity map: 10 px on the left, no depth on the right. */
function depthMap(): DepthMap {
  return {
    height: 1,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 1,
      values: new Uint16Array([10, 0]),
    },
    width: 2,
  };
}

function active(map: DepthMap, frameIndex = 0): ActiveDepthMap {
  return {
    frameIndex,
    map,
    mediaHeight: 1,
    mediaTime: 0,
    mediaWidth: 2,
    precision: "exact",
  };
}

/** A renderer whose screen is its media, pixel for pixel. */
function fakeRenderer(read: () => ActiveDepthMap | null) {
  const getActiveDepth = vi.fn(read);

  return {
    getActiveDepth,
    renderer: {
      getActiveDepth,
      screenToMedia: (point: { x: number; y: number }) => point,
    } as unknown as MediaRenderer,
  };
}

const target = {
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
} as unknown as Element;

describe("the workbench depth probe", () => {
  /* The pointer crosses the picture on every sample, depth on or off, and a
   * probe nobody reads must not cost a readout per move. */
  it("reads nothing while nothing listens", () => {
    const { getActiveDepth, renderer } = fakeRenderer(() => active(depthMap()));
    const probe = createDepthProbe(() => renderer);

    probe.onPointerMove({ clientX: 0, clientY: 0, currentTarget: target });
    probe.refresh();

    expect(getActiveDepth).not.toHaveBeenCalled();
    expect(probe.getSnapshot()).toEqual({ active: null, readout: null });
  });

  it("reads the stored value under the pointer, and nothing once it leaves", () => {
    const map = depthMap();
    const { renderer } = fakeRenderer(() => active(map));
    const probe = createDepthProbe(() => renderer);

    probe.subscribe(() => {});
    probe.onPointerMove({ clientX: 0.5, clientY: 0.5, currentTarget: target });

    expect(probe.getSnapshot().readout).toMatchObject({
      disparityPx: 10,
      stored: 10,
      valid: true,
      x: 0,
      y: 0,
    });

    probe.onPointerMove({ clientX: 1.5, clientY: 0.5, currentTarget: target });
    expect(probe.getSnapshot().readout).toMatchObject({ valid: false, x: 1 });

    probe.onPointerLeave();
    expect(probe.getSnapshot().readout).toBeNull();
    expect(probe.getSnapshot().active?.map).toBe(map);
  });

  /* Refresh runs on every renderer readout, four times a second while
   * playing, and each notification re-renders the legend and the readout. */
  it("tells its listeners only when the depth on screen changes", () => {
    const map = depthMap();
    let shown = active(map);
    const { renderer } = fakeRenderer(() => ({ ...shown }));
    const probe = createDepthProbe(() => renderer);
    const listener = vi.fn();

    probe.subscribe(listener);
    listener.mockClear();
    probe.refresh();
    probe.refresh();
    expect(listener).not.toHaveBeenCalled();

    shown = active(depthMap(), 1);
    probe.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(probe.getSnapshot().active?.frameIndex).toBe(1);
  });

  it("forgets the last depth once the last listener goes", () => {
    const { renderer } = fakeRenderer(() => active(depthMap()));
    const probe = createDepthProbe(() => renderer);
    const unsubscribe = probe.subscribe(() => {});

    expect(probe.getSnapshot().active).not.toBeNull();
    unsubscribe();
    expect(probe.getSnapshot()).toEqual({ active: null, readout: null });
  });
});
