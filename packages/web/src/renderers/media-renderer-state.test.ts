import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "supervision-js-core";
import { MediaRendererFit } from "#types/media-renderer";

import { createMediaRendererRuntimeState } from "./media-renderer-state";
import type { PresentedMediaSample } from "./media-renderer-scene";

describe("media renderer runtime state", () => {
  it("counts every frame a push producer puts on screen", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createSample(0));
    state.recordPresentationUpdate(createSample(0.04));
    state.recordPresentationUpdate(createSample(0.08));

    expect(state.snapshot().presentedFrames).toBe(3);
  });

  it("keeps the playhead and the frame count in step under a push producer", () => {
    const state = createRuntimeState();

    for (const mediaTime of [0, 0.04, 0.08, 0.12]) {
      state.recordPresentationUpdate(createSample(mediaTime));
      state.recordPlayheadTime(mediaTime);
    }

    expect(state.snapshot()).toMatchObject({
      currentTime: 0.12,
      presentedFrames: 4,
    });
  });

  it("counts a frame once however many times the scene redraws it", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createSample(0.04));
    state.recordPresentationUpdate({
      ...createSample(0.04),
      activeDetectionCount: 3,
    });

    expect(state.snapshot()).toMatchObject({
      activeDetectionCount: 3,
      presentedFrames: 1,
    });
  });

  it("leaves the count alone when the renderer redraws the frame on screen", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createSample(0.04));
    state.recordPresentationRefresh(createSample(0.04));

    expect(state.snapshot().presentedFrames).toBe(1);
  });

  it("counts nothing for a redraw the renderer asks for ahead of the first frame", () => {
    const state = createRuntimeState();

    state.recordPresentationRefresh(createSample(0));

    expect(state.snapshot().presentedFrames).toBe(0);
  });

  it("counts a playhead move as no frame at all", () => {
    const state = createRuntimeState();

    state.recordPlayheadTime(0.04);
    state.recordPlayheadTime(0.08);

    expect(state.snapshot()).toMatchObject({
      currentTime: 0.08,
      presentedFrames: 0,
    });
  });

  it("counts every sample the renderer pulls and presents", () => {
    const state = createRuntimeState();

    state.recordPresentedSample(createSample(0));
    state.recordPresentedSample(createSample(0.04));

    expect(state.snapshot().presentedFrames).toBe(2);
  });

  it("leaves the count alone when the scene redraws a pulled frame", () => {
    const state = createRuntimeState();

    state.recordPresentedSample(createSample(0.04));
    state.recordPresentationUpdate(createSample(0.04));

    expect(state.snapshot().presentedFrames).toBe(1);
  });

  it("publishes the running count with every state it emits", () => {
    const onState = vi.fn();
    const state = createRuntimeState({ onState });

    state.recordPresentationUpdate(createSample(0.04));

    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentTime: 0.04, presentedFrames: 1 }),
    );
  });
});

function createRuntimeState(
  overrides: Partial<
    Parameters<typeof createMediaRendererRuntimeState>[0]
  > = {},
) {
  return createMediaRendererRuntimeState({
    fit: MediaRendererFit.Contain,
    getDetectionBufferState: createIdleDetectionBufferState,
    playbackRate: 1,
    ...overrides,
  });
}

function createSample(mediaTime: number): PresentedMediaSample {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    detectionBuffer: createIdleDetectionBufferState(),
    mediaTime,
  };
}
