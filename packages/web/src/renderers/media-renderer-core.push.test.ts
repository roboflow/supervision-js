import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "supervision-js-core";
import type { DecodedMediaSource } from "#media/media-source";
import {
  MediaRendererPlaybackState,
  type MediaRendererOptions,
} from "#types/media-renderer";

import { createMediaRendererCore } from "./media-renderer-core";
import type { MediaRendererScene } from "./media-renderer-scene";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelSignal,
  PresentedFrameChannelStatus,
} from "./presented-frame-channel";

describe("media renderer over a push-based media source", () => {
  it("never pulls a sample", async () => {
    const producer = createProducer();
    const scene = createScene();

    const renderer = await createRenderer(producer, scene);

    expect(producer.getSample).not.toHaveBeenCalled();
    expect(producer.samples).not.toHaveBeenCalled();
    expect(scene.presentSample).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("forwards play, pause and toggle to the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    await renderer.play();
    renderer.pause();
    renderer.togglePlayback();

    expect(producer.play).toHaveBeenCalledOnce();
    expect(producer.pause).toHaveBeenCalledOnce();
    expect(producer.togglePlayback).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("drives a drag as scrubs inside one gesture and a seek that releases it", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    renderer.scrub(1);
    renderer.scrub(2);
    await renderer.seek(3);

    expect(producer.beginInteractiveSeek).toHaveBeenCalledOnce();
    expect(producer.scrub.mock.calls).toEqual([
      [1000, "gesture"],
      [2000, "gesture"],
    ]);
    expect(producer.commit).toHaveBeenCalledExactlyOnceWith(3000);
    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("leaves a seek outside a drag with no gesture to release", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    await renderer.seek(2);

    expect(producer.beginInteractiveSeek).not.toHaveBeenCalled();
    expect(producer.endInteractiveSeek).not.toHaveBeenCalled();
    expect(producer.commit).toHaveBeenCalledExactlyOnceWith(2000);
    renderer.destroy();
  });

  it("clamps a seek to the media it was opened over", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    await renderer.seek(90);

    expect(producer.commit).toHaveBeenCalledExactlyOnceWith(4000);
    renderer.destroy();
  });

  it("steps a real source frame in both directions", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    await renderer.stepForward();
    await renderer.stepBackward();

    expect(producer.step.mock.calls).toEqual([[1], [-1]]);
    renderer.destroy();
  });

  it("refuses a non-unit playback rate instead of faking it in the state", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    expect(() => renderer.setPlaybackRate(4)).toThrow(
      /fixed at 1 under engine-paced presentation/,
    );
    expect(renderer.getState().playbackRate).toBe(1);
    renderer.setPlaybackRate(1);
    renderer.destroy();
  });

  it("reads playback state from the producer, seeking included", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    producer.setSeeking(true);
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );

    producer.setSeeking(false);
    producer.setStatus("PAUSED");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    renderer.destroy();
  });

  it("replays from the start when the producer ends and loop is on", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("ENDED");

    expect(producer.play).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it("lets the source rest at the end when loop is off", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      loop: false,
    });

    producer.setStatus("ENDED");

    expect(producer.play).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );
    renderer.destroy();
  });

  it("adopts the producer's recovery after a transient error", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("ERRORED");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Error,
    );

    producer.setStatus("PLAYING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );
    renderer.destroy();
  });

  it("reads a producer that drops back to loading", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    producer.setStatus("LOADING");

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Loading,
    );
    renderer.destroy();
  });

  it("keeps the detection buffer hot as the producer's playhead moves", async () => {
    const producer = createProducer();
    const frames = [{ detections: [], frameIndex: 0, mediaTime: 1.5 }];
    const renderer = await createRenderer(producer, createScene(), {
      detectionFrames: frames,
    });

    producer.setTimeMs(1500);
    await vi.waitFor(() => {
      const buffer = renderer.getState().detectionBuffer;
      expect(buffer.status).toBe("ready");
      expect(buffer.frameCount).toBe(1);
    });

    renderer.destroy();
  });

  it("reads the playhead from the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setTimeMs(1500);

    expect(renderer.getState().currentTime).toBe(1.5);
    renderer.destroy();
  });

  it("stops listening to the producer once destroyed", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    renderer.destroy();
    producer.setTimeMs(2000);

    expect(renderer.getState().currentTime).toBe(0);
  });
});

async function createRenderer(
  producer: ReturnType<typeof createProducer>,
  scene: MediaRendererScene,
  overrides: Partial<MediaRendererOptions> = {},
) {
  return createMediaRendererCore(
    {
      autoPlay: false,
      container: {} as HTMLElement,
      source: { open: async () => producer.source },
      ...overrides,
    } satisfies MediaRendererOptions,
    {
      createScene: async () => scene,
      openMediaSource: vi.fn(),
    },
  );
}

function createProducer() {
  const listeners = new Map<PresentedFrameChannelSignal, Set<() => void>>([
    ["seeking", new Set()],
    ["state", new Set()],
    ["time", new Set()],
  ]);
  const announce = (signal: PresentedFrameChannelSignal) => {
    for (const listener of listeners.get(signal) ?? []) {
      listener();
    }
  };
  let status: PresentedFrameChannelStatus = "READY";
  let seeking = false;
  let timeMs = 0;

  const engine: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => 4000,
    getSeeking: () => seeking,
    getStatus: () => status,
    getTimeMs: () => timeMs,
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: (signal, listener) => {
      listeners.get(signal)?.add(listener);
      return () => listeners.get(signal)?.delete(listener);
    },
    togglePlayback: vi.fn(),
  };
  const getSample = vi.fn(async () => null);
  const samples = vi.fn(async function* () {});
  const source: DecodedMediaSource & {
    readonly engine: PresentedFrameChannel;
  } = {
    engine,
    input: { dispose: vi.fn() },
    metadata: {
      audioTrackCount: 0,
      canRead: true,
      duration: 4,
      firstTimestamp: 0,
      formatMimeType: null,
      formatName: "video-engine",
      mimeType: null,
      primaryVideoHeight: 720,
      primaryVideoWidth: 1280,
      trackCount: 1,
      videoTrackCount: 1,
    },
    sampleSink: { getSample, samples },
  };

  return {
    beginInteractiveSeek: engine.beginInteractiveSeek as ReturnType<
      typeof vi.fn
    >,
    commit: engine.commit as ReturnType<typeof vi.fn>,
    endInteractiveSeek: engine.endInteractiveSeek as ReturnType<typeof vi.fn>,
    getSample,
    pause: engine.pause as ReturnType<typeof vi.fn>,
    play: engine.play as ReturnType<typeof vi.fn>,
    samples,
    scrub: engine.scrub as ReturnType<typeof vi.fn>,
    setSeeking(next: boolean) {
      seeking = next;
      announce("seeking");
    },
    setStatus(next: PresentedFrameChannelStatus) {
      status = next;
      announce("state");
    },
    setTimeMs(next: number) {
      timeMs = next;
      announce("time");
    },
    source,
    step: engine.step as ReturnType<typeof vi.fn>,
    togglePlayback: engine.togglePlayback as ReturnType<typeof vi.fn>,
  };
}

function createScene(): MediaRendererScene {
  return {
    destroy: vi.fn(),
    initializeMedia: vi.fn(),
    presentSample: vi.fn(() => ({
      activeDetectionCount: 0,
      activeDetectionFrameIndex: null,
      activeDetectionFrameTime: null,
      detectionBuffer: createIdleDetectionBufferState(),
      mediaTime: 0,
    })),
    rendererBackend: "test",
    setPresentation: vi.fn(),
    setRenderQuality: vi.fn(),
    setTimelineContext: vi.fn(),
  };
}
