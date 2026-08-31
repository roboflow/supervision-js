import { describe, expect, it, vi } from "vitest";

import { BaseMaskStyle } from "supervision-js-core";
import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
} from "supervision-js-core";
import {
  DetectionMaskEncoding,
  type DetectionFrame,
} from "supervision-js-core";
import type {
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";
import {
  RenderPreparationGateHoldReason,
  RenderPreparationMode,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

import {
  domMock,
  flushAnimationFrame,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { MaskPreparationWorkerMessageType } from "../render-preparation/mask-preparation-worker-protocol";
import { createPreparedRenderWindow } from "../render-preparation/prepared-render-window";
import { createMediaPlaybackController } from "./media-playback-controller";

const FRAME_PITCH = 0.04;
const FRAME_COUNT = 400;
/**
 * A run of 24 cached frames leads the playhead by 23 frame pitches, 0.92s,
 * short of the second of lead this session's gate asks for. Reached by moving
 * the cache below the prefetch count, which the demo's session panel allows.
 */
const MASK_CACHE_FRAME_COUNT = 24;

const detectionFrames: DetectionFrame[] = Array.from(
  { length: FRAME_COUNT },
  (_, frameIndex) => ({
    detections: [
      {
        mask: {
          counts: "021",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 2,
          width: 2,
        },
      },
    ],
    frameIndex,
    mediaTime: frameIndex * FRAME_PITCH,
  }),
);

function createDetectionTimeline(): BufferedDetectionTimeline {
  return {
    destroy: vi.fn(),
    getBufferedFrames: vi.fn(() => detectionFrames),
    getState: vi.fn(() => ({
      bufferEndTime: FRAME_COUNT * FRAME_PITCH,
      bufferStartTime: 0,
      detectionCount: detectionFrames.length,
      errorMessage: null,
      frameCount: detectionFrames.length,
      requestedEndTime: FRAME_COUNT * FRAME_PITCH,
      requestedStartTime: 0,
      status: DetectionBufferStatus.Ready,
    })),
    prepare: vi.fn(),
    prefetch: vi.fn(),
    selectFrame: vi.fn(
      (mediaTime: number) =>
        detectionFrames[
          Math.min(
            FRAME_COUNT - 1,
            Math.max(0, Math.floor(mediaTime / FRAME_PITCH + 1e-6)),
          )
        ],
    ),
  };
}

function createManualMaskWorker() {
  const messages: Array<{
    readonly job: { readonly key: string };
    readonly requestId: number;
  }> = [];
  const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  let completedCount = 0;

  const worker = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") {
        listeners.push(listener as (event: MessageEvent<unknown>) => void);
      }
    },
    postMessage(message: {
      readonly job: { readonly key: string };
      readonly requestId: number;
    }) {
      messages.push(message);
    },
    terminate() {},
  } as unknown as Worker;

  return {
    completeNext() {
      const message = messages[completedCount];

      if (!message) {
        return false;
      }

      completedCount += 1;

      for (const listener of listeners) {
        listener({
          data: {
            imageData: new ImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2),
            key: message.job.key,
            requestId: message.requestId,
            type: MaskPreparationWorkerMessageType.Complete,
          },
        } as MessageEvent<unknown>);
      }

      return true;
    },
    get completedCount() {
      return completedCount;
    },
    worker,
  };
}

function createSampleSink(): DecodedVideoSampleSink {
  const createSample = (timestamp: number): DecodedVideoSample => ({
    close: vi.fn(),
    draw: vi.fn(),
    duration: FRAME_PITCH,
    timestamp,
  });

  return {
    async getSample(timestamp: number) {
      return createSample(timestamp);
    },
    async *samples(startTimestamp = 0) {
      let frameIndex = Math.max(0, Math.round(startTimestamp / FRAME_PITCH));

      while (frameIndex < FRAME_COUNT) {
        yield createSample(frameIndex * FRAME_PITCH);
        frameIndex += 1;
      }
    },
  };
}

const GATE_OPTIONS = {
  enabled: true,
  minimumAheadSeconds: 0.25,
  requiredAheadSeconds: 1,
};

function createGateRenderWindow(options: {
  readonly onDiagnostics: (diagnostics: RenderPreparationDiagnostics) => void;
  readonly worker: Worker;
}) {
  return createPreparedRenderWindow({
    detectionTimeline: createDetectionTimeline(),
    maskStyle: new BaseMaskStyle(),
    renderPreparation: {
      maskFrame: {
        maxCacheFrameCount: MASK_CACHE_FRAME_COUNT,
        maxPendingFrameCount: 24,
        prefetchFrameCount: 175,
        scanIntervalSeconds: 0.1,
        scheduleBatchSize: 16,
        workerCount: 1,
      },
      mode: RenderPreparationMode.Worker,
      onDiagnostics: options.onDiagnostics,
      workerFactory: { createWorker: () => options.worker },
    },
  });
}

describe("pull playback under the render preparation gate", () => {
  it("keeps playing on a mask cache smaller than the required lead", async () => {
    vi.useFakeTimers();
    resetMocks();

    const maskWorker = createManualMaskWorker();
    const diagnostics: RenderPreparationDiagnostics[] = [];
    const renderWindow = createGateRenderWindow({
      onDiagnostics: (next) => diagnostics.push(next),
      worker: maskWorker.worker,
    });

    renderWindow.setPlaybackActive(true);

    const presented: number[] = [];
    const controller = createMediaPlaybackController({
      duration: FRAME_COUNT * FRAME_PITCH,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      onCurrentTimeChange: () => {},
      onEnded: () => {},
      onError: (error) => {
        throw error;
      },
      presentSample: (sample) => {
        presented.push(sample.timestamp);
        renderWindow.getFrame(sample.timestamp);
        sample.close();
      },
      sampleSink: createSampleSink(),
      waitForSample: async (sample, signal) => {
        await renderWindow.waitForReady(sample.timestamp, GATE_OPTIONS, signal);
      },
    });

    renderWindow.getFrame(0);

    for (let round = 0; round < 60; round += 1) {
      for (let completion = 0; completion < 8; completion += 1) {
        maskWorker.completeNext();
      }
      await vi.advanceTimersByTimeAsync(1);
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    }

    controller.play();

    let elapsedMs = 0;
    const advanceFrame = async (maskCompletions: number) => {
      elapsedMs += 16;

      for (let completion = 0; completion < maskCompletions; completion += 1) {
        if (!maskWorker.completeNext()) {
          break;
        }
      }

      await vi.advanceTimersByTimeAsync(0);
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();

      if (domMock.rafCallbacks.length > 0) {
        flushAnimationFrame(elapsedMs);
      }

      await vi.advanceTimersByTimeAsync(0);
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    };

    for (let tick = 0; tick < 40; tick += 1) {
      await advanceFrame(64);
    }

    const presentedWhilePlaying = presented.length;

    for (let tick = 0; tick < 60; tick += 1) {
      await advanceFrame(0);
    }

    const presentedWhileStarved = presented.length;
    const heldWhileStarved = diagnostics.some(
      (entry) =>
        entry.artifacts?.[0]?.gateHold?.reason ===
        RenderPreparationGateHoldReason.LeadBelowRequirement,
    );

    for (let tick = 0; tick < 100; tick += 1) {
      await advanceFrame(64);
    }

    const presentedAfterFirstCatchUp = presented.length;

    for (let tick = 0; tick < 100; tick += 1) {
      await advanceFrame(64);
    }

    const presentedAfterSecondCatchUp = presented.length;

    controller.destroy();
    renderWindow.destroy();
    vi.useRealTimers();

    expect({
      heldWhileStarved,
      keptGoingAfterCatchUp:
        presentedAfterSecondCatchUp > presentedAfterFirstCatchUp,
      playedBeforeStarving: presentedWhilePlaying > 0,
      resumedAfterStarving: presentedAfterFirstCatchUp > presentedWhileStarved,
    }).toEqual({
      heldWhileStarved: true,
      keptGoingAfterCatchUp: true,
      playedBeforeStarving: true,
      resumedAfterStarving: true,
    });
  });

  it("drops the gate hold a superseded run walked away from", async () => {
    vi.useFakeTimers();
    resetMocks();

    const maskWorker = createManualMaskWorker();
    const diagnostics: RenderPreparationDiagnostics[] = [];
    const renderWindow = createGateRenderWindow({
      onDiagnostics: (next) => diagnostics.push(next),
      worker: maskWorker.worker,
    });

    renderWindow.setPlaybackActive(true);

    const controller = createMediaPlaybackController({
      duration: FRAME_COUNT * FRAME_PITCH,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      onCurrentTimeChange: () => {},
      onEnded: () => {},
      onError: (error) => {
        throw error;
      },
      presentSample: (sample) => {
        renderWindow.getFrame(sample.timestamp);
        sample.close();
      },
      sampleSink: createSampleSink(),
      waitForSample: async (sample, signal) => {
        await renderWindow.waitForReady(sample.timestamp, GATE_OPTIONS, signal);
      },
    });

    renderWindow.getFrame(0);

    let elapsedMs = 0;
    const advanceFrame = async () => {
      elapsedMs += 16;
      await vi.advanceTimersByTimeAsync(0);
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();

      if (domMock.rafCallbacks.length > 0) {
        flushAnimationFrame(elapsedMs);
      }

      await vi.advanceTimersByTimeAsync(0);
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    };

    for (let tick = 0; tick < 10; tick += 1) {
      await advanceFrame();
    }

    controller.play();

    for (let tick = 0; tick < 10; tick += 1) {
      await advanceFrame();
    }

    const readGateHold = () =>
      diagnostics[diagnostics.length - 1]?.artifacts?.[0]?.gateHold?.reason ??
      null;
    const heldWhilePlaying = readGateHold();

    controller.pause();
    renderWindow.setPlaybackActive(false);

    const heldAfterPause = readGateHold();

    controller.destroy();
    renderWindow.destroy();
    vi.useRealTimers();

    expect({ heldAfterPause, heldWhilePlaying }).toEqual({
      heldAfterPause: null,
      heldWhilePlaying: RenderPreparationGateHoldReason.ActiveFrameUnprepared,
    });
  });
});
