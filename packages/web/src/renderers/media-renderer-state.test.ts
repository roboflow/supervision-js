import { describe, expect, it, vi } from "vitest";

import {
  PlaybackGateReach,
  createIdleDetectionBufferState,
} from "supervision-js-core";
import { MediaRendererFit } from "#types/media-renderer";

import { createMediaRendererRuntimeState } from "./media-renderer-state";
import type { PresentedMediaSample } from "./media-renderer-scene";

describe("media renderer runtime state", () => {
  it("counts every frame a push producer puts on screen", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createPresentedFrame(0, 1));
    state.recordPresentationUpdate(createPresentedFrame(0.04, 2));
    state.recordPresentationUpdate(createPresentedFrame(0.08, 3));

    expect(state.snapshot().presentedFrames).toBe(3);
  });

  it("counts a producer's second presentation of one media time twice", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createPresentedFrame(0.04, 1));
    state.recordPresentationUpdate(createPresentedFrame(0.04, 2));

    expect(state.snapshot().presentedFrames).toBe(2);
  });

  it("keeps the playhead and the frame count in step under a push producer", () => {
    const state = createRuntimeState();

    for (const [index, mediaTime] of [0, 0.04, 0.08, 0.12].entries()) {
      state.recordPresentationUpdate(
        createPresentedFrame(mediaTime, index + 1),
      );
      state.recordPlayheadTime(mediaTime);
    }

    expect(state.snapshot()).toMatchObject({
      currentTime: 0.12,
      presentedFrames: 4,
    });
  });

  it("counts a frame once however many times the scene redraws it", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createPresentedFrame(0.04, 1));
    state.recordPresentationUpdate({
      ...createPresentedFrame(0.04, 1),
      activeDetectionCount: 3,
    });

    expect(state.snapshot()).toMatchObject({
      activeDetectionCount: 3,
      presentedFrames: 1,
    });
  });

  it("counts no new frame when the scene redraws the frame on screen at a moved playhead", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createPresentedFrame(0.04, 1));
    state.recordPresentationUpdate(createPresentedFrame(0.08, 1));

    expect(state.snapshot()).toMatchObject({
      currentTime: 0.08,
      presentedFrames: 1,
    });
  });

  it("counts nothing for a redraw the renderer asks for ahead of the first frame", () => {
    const state = createRuntimeState();

    state.recordPresentationUpdate(createPresentedFrame(0, 0));

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

    state.recordPresentedSample(createPresentedFrame(0, 1));
    state.recordPresentedSample(createPresentedFrame(0.04, 2));

    expect(state.snapshot().presentedFrames).toBe(2);
  });

  it("counts a pulled sample the renderer presents at the media time before it", () => {
    const state = createRuntimeState();

    state.recordPresentedSample(createPresentedFrame(0.04, 1));
    state.recordPresentedSample(createPresentedFrame(0.04, 2));

    expect(state.snapshot().presentedFrames).toBe(2);
  });

  it("leaves the count alone when the scene redraws a pulled frame", () => {
    const state = createRuntimeState();

    state.recordPresentedSample(createPresentedFrame(0.04, 1));
    state.recordPresentationUpdate(createPresentedFrame(0.04, 1));

    expect(state.snapshot().presentedFrames).toBe(1);
  });

  it("publishes the running count with every state it emits", () => {
    const onState = vi.fn();
    const state = createRuntimeState({ onState });

    state.recordPresentationUpdate(createPresentedFrame(0.04, 1));

    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentTime: 0.04, presentedFrames: 1 }),
    );
  });

  it("reports how far the playback gate reaches on this source", () => {
    for (const reach of [
      PlaybackGateReach.Off,
      PlaybackGateReach.EveryFrame,
      PlaybackGateReach.StartOfPlayback,
    ]) {
      const runtimeState = createRuntimeState({
        getPlaybackGateReach: () => reach,
      });

      // One option holds every frame on a pulled source and only the start on a
      // source that presents its own, so a host has to be able to read which.
      expect(runtimeState.snapshot().playbackGateReach).toBe(reach);
    }
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
    getPlaybackGateReach: () => PlaybackGateReach.Off,
    playbackRate: 1,
    ...overrides,
  });
}

function createPresentedFrame(
  mediaTime: number,
  presentedFrameSerial: number,
): PresentedMediaSample {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    detectionBuffer: createIdleDetectionBufferState(),
    drawnMaskFrameTime: null,
    maskHeldStale: false,
    mediaTime,
    presentedFrameSerial,
  };
}
