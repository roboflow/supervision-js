import { describe, expect, it, vi } from "vitest";

import { createIdleDetectionBufferState } from "supervision-js-core";
import type { DetectionFrame, DetectionFrameSource } from "supervision-js-core";
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
  PresentedVideoFrame,
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

  it("forwards play and pause to the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    await renderer.play();
    renderer.pause();

    expect(producer.play).toHaveBeenCalledOnce();
    expect(producer.pause).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("plays a toggle the producer has yet to answer as a pause", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    await renderer.togglePlayback();
    await renderer.togglePlayback();

    expect(producer.pause).toHaveBeenCalledOnce();
    expect(producer.play).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("says why the play behind a toggle failed", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PAUSED");
    producer.play.mockRejectedValueOnce(new Error("video engine crashed"));

    await expect(renderer.togglePlayback()).rejects.toThrow(
      "video engine crashed",
    );
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

  it("releases the drag a pause interrupts", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(1);
    renderer.pause();

    expect(producer.pause).toHaveBeenCalledOnce();
    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("gives a scrub after that pause a gesture of its own", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(1);
    renderer.pause();
    renderer.scrub(2);
    await renderer.seek(3);

    expect(producer.beginInteractiveSeek).toHaveBeenCalledTimes(2);
    expect(producer.endInteractiveSeek).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it("pauses on a toggle inside a drag the player entered playing", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(1);
    await renderer.togglePlayback();

    expect(producer.pause).toHaveBeenCalledOnce();
    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("plays on a toggle inside a drag the player entered paused", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PAUSED");
    renderer.scrub(1);
    await renderer.togglePlayback();

    expect(producer.play).toHaveBeenCalledOnce();
    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("keeps a scrub landing with the seek inside the drag it belongs to", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(1);
    const landing = renderer.seek(2);
    renderer.scrub(2);
    await landing;

    expect(producer.beginInteractiveSeek).toHaveBeenCalledOnce();
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

  it("hands a non-unit playback rate to the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    renderer.setPlaybackRate(4);

    expect(producer.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(4);
    renderer.destroy();
  });

  it("reads the playback rate back from the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    renderer.setPlaybackRate(2);

    expect(renderer.getState().playbackRate).toBe(2);
    renderer.destroy();
  });

  it("opens at the rate it was asked for", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      playbackRate: 2,
    });

    expect(producer.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(2);
    expect(renderer.getState().playbackRate).toBe(2);
    renderer.destroy();
  });

  it("keeps the rate the producer reports through a drag", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    renderer.setPlaybackRate(2);
    renderer.scrub(1);
    await renderer.seek(3);

    expect(renderer.getState().playbackRate).toBe(2);
    renderer.destroy();
  });

  it("lets a rate the producer refuses reach the caller", async () => {
    const producer = createProducer();
    producer.setPlaybackRate.mockImplementationOnce(() => {
      throw new Error("playback rate 32 is outside the supported range");
    });
    const renderer = await createRenderer(producer, createScene());

    expect(() => renderer.setPlaybackRate(32)).toThrow(
      /outside the supported range/,
    );
    expect(renderer.getState().playbackRate).toBe(1);
    renderer.destroy();
  });

  it("reads playback state from the producer", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    producer.setStatus("PAUSED");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    renderer.destroy();
  });

  it("reports the stopped picture through a drag, and playing again on release", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(2);
    producer.setStatus("PAUSED");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    producer.setSeeking(true);
    producer.setStatus("SEEKING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    producer.setSeeking(false);
    await renderer.seek(3);
    producer.setStatus("PLAYING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    renderer.destroy();
  });

  it("resumes on release the playback a drag stopped", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    renderer.scrub(2);
    producer.setStatus("PAUSED");
    await renderer.seek(3);

    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("leaves a drag that started paused paused on release", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PAUSED");
    renderer.scrub(2);
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    await renderer.seek(3);
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    renderer.destroy();
  });

  it("keeps playing while a seek settles under playback", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    producer.setSeeking(true);
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    producer.setStatus("SEEKING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    producer.setSeeking(false);
    producer.setStatus("PLAYING");
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    renderer.destroy();
  });

  it("never reports buffering for a scrub while paused", async () => {
    const producer = createProducer();
    const onState = vi.fn();
    const renderer = await createRenderer(producer, createScene(), { onState });

    producer.setStatus("PAUSED");
    renderer.scrub(1);
    producer.setSeeking(true);
    producer.setStatus("SEEKING");
    producer.setTimeMs(1000);

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    await renderer.seek(1);
    producer.setSeeking(false);
    producer.setStatus("PAUSED");

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );
    expect(onState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        playbackState: MediaRendererPlaybackState.Buffering,
      }),
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

  it("reports buffering for a producer that drops back to loading mid-playback", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

    producer.setStatus("PLAYING");
    producer.setStatus("LOADING");

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );
    renderer.destroy();
  });

  it("reads a producer still loading before playback", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene());

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

  it("holds a pushed frame until its advertised detections are in the buffer", async () => {
    const producer = createProducer();
    const secondWindow = createDeferred<readonly DetectionFrame[]>();
    const source: DetectionFrameSource = {
      getAvailableRanges: () => [{ endTime: 4, startTime: 0 }],
      loadFrames: vi.fn(async (startTime) =>
        startTime < 1
          ? [{ detections: [], frameIndex: 0, mediaTime: 0 }]
          : secondWindow.promise,
      ),
      waitForRange: vi.fn(async () => undefined),
    };
    const renderer = await createRenderer(producer, createScene(), {
      detectionBuffer: {
        bufferAheadSeconds: 0,
        bufferBehindSeconds: 0,
        playbackGate: { enabled: true },
      },
      detectionSource: source,
    });
    await vi.waitFor(() => expect(source.loadFrames).toHaveBeenCalled());

    const presented = producer.present(2000);
    await vi.waitFor(() =>
      expect(source.loadFrames).toHaveBeenCalledWith(
        2,
        2,
        expect.objectContaining({
          coordinateSpace: { height: 720, width: 1280 },
        }),
      ),
    );

    expect(presented.frame.close).not.toHaveBeenCalled();

    secondWindow.resolve([{ detections: [], frameIndex: 1, mediaTime: 2 }]);
    await vi.waitFor(() =>
      expect(presented.frame.close).toHaveBeenCalledOnce(),
    );

    renderer.destroy();
  });

  it("enters Error and stops the producer when the scene rejects a later frame", async () => {
    const producer = createProducer();
    let presentations = 0;
    const renderer = await createRenderer(
      producer,
      createScene(),
      {},
      (presented) => {
        presentations += 1;
        presented.frame.close();
        if (presentations > 1) throw new Error("later scene upload failed");
      },
    );

    const failed = producer.present(1000);

    expect(renderer.getState()).toMatchObject({
      playbackState: MediaRendererPlaybackState.Error,
      source: { errorMessage: "later scene upload failed" },
    });
    expect(producer.pause).toHaveBeenCalledOnce();
    expect(failed.frame.close).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("does not overwrite an initialization-time scene failure with Ready", async () => {
    const producer = createProducer();
    producer.commit.mockImplementationOnce(async (nextTimeMs: number) => {
      producer.present(nextTimeMs);
      producer.present(nextTimeMs + 1000);
    });
    let presentations = 0;

    const renderer = await createRenderer(
      producer,
      createScene(),
      { autoPlay: true },
      (presented) => {
        presentations += 1;
        presented.frame.close();
        if (presentations > 1) {
          throw new Error("initial replacement upload failed");
        }
      },
    );

    expect(renderer.getState()).toMatchObject({
      playbackState: MediaRendererPlaybackState.Error,
      source: { errorMessage: "initial replacement upload failed" },
    });
    expect(producer.pause).toHaveBeenCalledOnce();
    expect(producer.play).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it.each([
    [
      "seek",
      2,
      (renderer: Awaited<ReturnType<typeof createRenderer>>) =>
        renderer.seek(2),
    ],
    [
      "step",
      1,
      (renderer: Awaited<ReturnType<typeof createRenderer>>) =>
        renderer.stepForward(),
    ],
  ])(
    "keeps %s pending until the guarded landing reaches the scene",
    async (_name, targetTime, navigate) => {
      const producer = createProducer();
      const landingWindow = createDeferred<readonly DetectionFrame[]>();
      const source: DetectionFrameSource = {
        getAvailableRanges: () => [{ endTime: 4, startTime: 0 }],
        loadFrames: vi.fn(async (startTime) =>
          startTime < 1
            ? [{ detections: [], frameIndex: 0, mediaTime: 0 }]
            : landingWindow.promise,
        ),
        waitForRange: vi.fn(async () => undefined),
      };
      const renderer = await createRenderer(producer, createScene(), {
        detectionBuffer: {
          bufferAheadSeconds: 0,
          bufferBehindSeconds: 0,
          playbackGate: { enabled: true },
        },
        detectionSource: source,
      });
      let settled = false;

      const navigation = navigate(renderer).then(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(source.loadFrames).toHaveBeenCalledWith(
          targetTime,
          targetTime,
          expect.objectContaining({
            coordinateSpace: { height: 720, width: 1280 },
          }),
        ),
      );
      await Promise.resolve();

      expect(settled).toBe(false);

      landingWindow.resolve([
        {
          detections: [],
          frameIndex: targetTime,
          mediaTime: targetTime,
        },
      ]);
      await navigation;
      expect(settled).toBe(true);
      renderer.destroy();
    },
  );

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

  it("holds the producer until prepared artifacts cover the frame it starts on", async () => {
    const producer = createProducer();
    const preparation = createPendingRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
    );

    const play = renderer.play();
    await Promise.resolve();

    expect(preparation.waitForRenderPreparation).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ enabled: true }),
      expect.any(AbortSignal),
    );
    expect(producer.play).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );

    preparation.resolve();
    await play;

    expect(producer.play).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("gives up on a preparer that answers nothing at the start of playback", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      const play = renderer.play();
      await vi.advanceTimersByTimeAsync(0);

      expect(producer.play).not.toHaveBeenCalled();
      expect(renderer.getState().playbackState).toBe(
        MediaRendererPlaybackState.Buffering,
      );

      await vi.advanceTimersByTimeAsync(2000);
      await play;

      expect(producer.play).toHaveBeenCalledOnce();
      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never starts the producer on a gate the caller left unbounded", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        {
          renderPreparation: {
            playbackGate: { enabled: true, maxWaitSeconds: Infinity },
          },
        },
      );

      let playSettled = false;
      const play = renderer.play().then(() => {
        playSettled = true;
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(playSettled).toBe(false);
      expect(producer.play).not.toHaveBeenCalled();
      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      preparation.prepare();
      await play;

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the producer without holding it at all on a bound of zero", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        {
          renderPreparation: {
            playbackGate: { enabled: true, maxWaitSeconds: 0 },
          },
        },
      );

      const play = renderer.play();
      await vi.advanceTimersByTimeAsync(0);
      await play;

      expect(producer.play).toHaveBeenCalledOnce();
      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the producer at once when no gate is enabled", async () => {
    const producer = createProducer();
    const preparation = createPendingRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
    );

    await renderer.play();

    expect(preparation.waitForRenderPreparation).not.toHaveBeenCalled();
    expect(producer.play).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("stops a running producer at a frame whose masks are not prepared", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
    );

    producer.setStatus("PLAYING");
    producer.setTimeMs(1000);

    expect(preparation.waitForRenderPreparation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ enabled: true }),
      expect.any(AbortSignal),
    );
    expect(producer.beginInteractiveSeek).toHaveBeenCalledOnce();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );

    preparation.prepare();
    await vi.waitFor(() =>
      expect(producer.endInteractiveSeek).toHaveBeenCalledOnce(),
    );
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    renderer.destroy();
  });

  it("gives the producer back when the masks never arrive, and does not stop it again every frame after", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);

      expect(producer.endInteractiveSeek).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);

      expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
      expect(renderer.getState()).toMatchObject({
        playbackState: MediaRendererPlaybackState.Playing,
        renderPreparationGateAbandoned: true,
      });

      producer.setTimeMs(2000);

      expect(producer.beginInteractiveSeek).toHaveBeenCalledOnce();

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits again once the masks have caught the playhead up", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      preparation.prepare();
      producer.setTimeMs(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      preparation.stall();
      producer.setTimeMs(3000);

      expect(producer.beginInteractiveSeek).toHaveBeenCalledTimes(2);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds again once the playhead is back inside covered artifacts", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      preparation.cover();
      producer.setTimeMs(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      preparation.stall();
      producer.setTimeMs(3000);

      expect(producer.beginInteractiveSeek).toHaveBeenCalledTimes(2);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds again for a preparer that is losing, and stays out of a stopped one's way", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      preparation.completeFrame();
      producer.setTimeMs(2000);

      expect(producer.beginInteractiveSeek).toHaveBeenCalledTimes(2);
      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      producer.setTimeMs(3000);

      expect(producer.beginInteractiveSeek).toHaveBeenCalledTimes(2);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { cooks: "always" as const, label: "every frame it can" },
    {
      cooks: "while stopped" as const,
      label: "only while the picture is stopped",
    },
  ])(
    "keeps stopping for a preparer that finishes $label",
    async ({ cooks }) => {
      vi.useFakeTimers();

      try {
        const producer = createProducer();
        const preparation = createStuckRenderPreparation();
        const renderer = await createRenderer(
          producer,
          createScene(preparation.scene),
          { renderPreparation: { playbackGate: { enabled: true } } },
        );

        producer.setStatus("PLAYING");

        const { holds, mediaTimeMs } = await driveThrottledPlayback(
          producer,
          preparation,
          cooks,
        );

        expect({ holds, mediaTimeMs }).toEqual({
          holds: 10,
          mediaTimeMs: 2500,
        });

        renderer.destroy();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("stops once for a preparer that finishes nothing, and plays the rest through", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");

      const { holds, mediaTimeMs } = await driveThrottledPlayback(
        producer,
        preparation,
        "never",
      );

      expect({ holds, mediaTimeMs }).toEqual({ holds: 1, mediaTimeMs: 18250 });

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds for the bound the caller asked for", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        {
          renderPreparation: {
            playbackGate: { enabled: true, maxWaitSeconds: 5 },
          },
        },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never gives up on a gate the caller left unbounded", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        {
          renderPreparation: {
            playbackGate: { enabled: true, maxWaitSeconds: Infinity },
          },
        },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);
      expect(producer.endInteractiveSeek).not.toHaveBeenCalled();

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([-1, -Infinity])(
    "gives the producer straight back on a bound of %s",
    async (maxWaitSeconds) => {
      vi.useFakeTimers();

      try {
        const producer = createProducer();
        const preparation = createStuckRenderPreparation();
        const renderer = await createRenderer(
          producer,
          createScene(preparation.scene),
          {
            renderPreparation: {
              playbackGate: { enabled: true, maxWaitSeconds },
            },
          },
        );

        producer.setStatus("PLAYING");
        producer.setTimeMs(1000);
        await vi.advanceTimersByTimeAsync(0);

        expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

        renderer.destroy();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("arms the gate again on the wait a play makes before it starts", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        { renderPreparation: { playbackGate: { enabled: true } } },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(true);

      const play = renderer.play();

      await vi.advanceTimersByTimeAsync(0);
      preparation.prepare();
      await play;

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the mask hold when the detection hold beside it fails", async () => {
    vi.useFakeTimers();

    try {
      const producer = createProducer();
      const preparation = createStuckRenderPreparation();
      const renderer = await createRenderer(
        producer,
        createScene(preparation.scene),
        {
          detectionBuffer: { playbackGate: { enabled: true } },
          detectionSource: createFailingDetectionSource(),
          renderPreparation: { playbackGate: { enabled: true } },
        },
      );

      producer.setStatus("PLAYING");
      producer.setTimeMs(1000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(renderer.getState().renderPreparationGateAbandoned).toBe(false);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the producer stopped when a play lands during a mask hold", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
    );

    producer.setStatus("PLAYING");
    producer.setTimeMs(1000);
    const play = renderer.play();

    await vi.waitFor(() =>
      expect(preparation.waitForRenderPreparation).toHaveBeenCalledTimes(2),
    );

    expect(producer.endInteractiveSeek).not.toHaveBeenCalled();
    expect(producer.play).not.toHaveBeenCalled();

    preparation.prepare();
    await play;

    expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
    expect(producer.play).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it("drops a mask hold the viewer paused out from under", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
    );

    producer.setStatus("PLAYING");
    producer.setTimeMs(1000);
    renderer.pause();

    await vi.waitFor(() =>
      expect(producer.endInteractiveSeek).toHaveBeenCalledOnce(),
    );

    renderer.destroy();
  });

  it("holds a running producer for detections and masks together", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      {
        detectionBuffer: { playbackGate: { enabled: true } },
        renderPreparation: { playbackGate: { enabled: true } },
      },
    );

    producer.setStatus("PLAYING");
    producer.setTimeMs(1000);

    expect(preparation.waitForRenderPreparation).toHaveBeenCalledOnce();
    expect(producer.beginInteractiveSeek).toHaveBeenCalledOnce();

    preparation.prepare();
    await vi.waitFor(() =>
      expect(producer.endInteractiveSeek).toHaveBeenCalledOnce(),
    );

    renderer.destroy();
  });

  it("abandons a held play the viewer paused before readiness landed", async () => {
    const producer = createProducer();
    const preparation = createPendingRenderPreparation();
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
    );

    const play = renderer.play();
    await Promise.resolve();
    renderer.pause();
    preparation.resolve();
    await play;

    expect(producer.play).not.toHaveBeenCalled();
    expect(producer.pause).toHaveBeenCalledOnce();
    renderer.destroy();
  });
});

/**
 * A scene whose artifacts are never cooked until the test says so, answering
 * the gate's cheap question the way the prepared window would.
 */
function createStuckRenderPreparation() {
  let isPrepared = false;
  let progress = 0;
  const releases = new Set<() => void>();
  const needsRenderPreparationWait = vi.fn(
    (mediaTime: number) => mediaTime > 0 && !isPrepared,
  );
  const getRenderPreparationProgress = vi.fn(() => progress);
  const waitForRenderPreparation = vi.fn(
    (_mediaTime: number, _gateOptions: unknown, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        releases.add(resolve);
        signal?.addEventListener("abort", () => resolve());
      }),
  );

  return {
    /** A cook that landed somewhere behind a playhead it still cannot cover. */
    completeFrame() {
      progress += 1;
    },
    /** Artifacts that were cooked before the hold, so no progress count moves. */
    cover() {
      isPrepared = true;

      for (const release of releases) {
        release();
      }

      releases.clear();
    },
    getRenderPreparationProgress,
    needsRenderPreparationWait,
    prepare() {
      isPrepared = true;
      progress += 1;

      for (const release of releases) {
        release();
      }

      releases.clear();
    },
    scene: {
      getRenderPreparationProgress,
      needsRenderPreparationWait,
      waitForRenderPreparation,
    },
    stall: () => {
      isPrepared = false;
    },
    waitForRenderPreparation,
  };
}

/**
 * Twenty seconds on a machine where cooking and decoding contend for one core:
 * the playhead only moves while the producer is running, so a cook scheduled
 * `while stopped` lands during a hold and never during playback.
 */
async function driveThrottledPlayback(
  producer: ReturnType<typeof createProducer>,
  preparation: ReturnType<typeof createStuckRenderPreparation>,
  cooks: "always" | "never" | "while stopped",
) {
  const stepMs = 250;
  let mediaTimeMs = 0;

  for (let step = 0; step < 80; step += 1) {
    const stopped =
      producer.beginInteractiveSeek.mock.calls.length >
      producer.endInteractiveSeek.mock.calls.length;

    if (cooks === "always" || (cooks === "while stopped" && stopped)) {
      preparation.completeFrame();
    }

    if (!stopped) {
      mediaTimeMs += stepMs;
      producer.setTimeMs(mediaTimeMs);
    }

    await vi.advanceTimersByTimeAsync(stepMs);
  }

  return {
    holds: producer.beginInteractiveSeek.mock.calls.length,
    mediaTimeMs,
  };
}

/** A detection source whose coverage wait fails rather than lands. */
function createFailingDetectionSource(): DetectionFrameSource {
  return {
    getAvailableRanges: () => [],
    loadFrames: async () => [],
    waitForRange: () => Promise.reject(new Error("Detections are gone.")),
  };
}

function createPendingRenderPreparation() {
  let release: (() => void) | undefined;
  const waitForRenderPreparation = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );

  return {
    resolve: () => release?.(),
    scene: { waitForRenderPreparation },
    waitForRenderPreparation,
  };
}

async function createRenderer(
  producer: ReturnType<typeof createProducer>,
  scene: MediaRendererScene,
  overrides: Partial<MediaRendererOptions> = {},
  presentFrame: (presented: PresentedVideoFrame) => void = (presented) =>
    presented.frame.close(),
) {
  const renderer = await createMediaRendererCore(
    {
      autoPlay: false,
      container: {} as HTMLElement,
      source: { open: async () => producer.source },
      ...overrides,
    } satisfies MediaRendererOptions,
    {
      createScene: async (sceneOptions) => {
        // A real push scene subscribes while it is being built and owns every
        // VideoFrame it accepts. This harness keeps that ownership boundary
        // without needing Pixi just to acknowledge the first presentation.
        sceneOptions.presentedFrames?.onPresentedFrame(presentFrame);
        return scene;
      },
      openMediaSource: vi.fn(),
    },
  );
  // Initialization recommits the first frame so Ready means real pixels have
  // reached the scene. Individual transport tests start after that contract.
  producer.commit.mockClear();
  producer.beginInteractiveSeek.mockClear();
  producer.endInteractiveSeek.mockClear();
  return renderer;
}

function createProducer() {
  const listeners = new Map<PresentedFrameChannelSignal, Set<() => void>>([
    ["rate", new Set()],
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
  let rate = 1;
  let frameHandler: Parameters<PresentedFrameChannel["onPresentedFrame"]>[0] = (
    presented,
  ) => presented.frame.close();
  let paintSeq = 0;

  const present = (nextTimeMs: number) => {
    timeMs = nextTimeMs;
    const index = Math.trunc(timeMs / 1000);
    const presented = {
      frame: { close: vi.fn() } as unknown as VideoFrame,
      frameId: { index, ticks: timeMs },
      mediaTimeS: timeMs / 1000,
      paintSeq: ++paintSeq,
    };
    frameHandler(presented);
    announce("time");
    return presented;
  };

  const engine: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async (nextTimeMs: number) => {
      present(nextTimeMs);
    }),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => 4000,
    getPlaybackRate: () => rate,
    getSeeking: () => seeking,
    getStatus: () => status,
    getPlayhead: () => ({
      frame: { index: Math.trunc(timeMs / 1000), ticks: timeMs },
      mediaTimeS: timeMs / 1000,
    }),
    onPresentedFrame: vi.fn((handler) => {
      frameHandler = handler;
    }),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    setPlaybackRate: vi.fn((next: number) => {
      if (next === rate) {
        return;
      }

      rate = next;
      announce("rate");
    }),
    step: vi.fn(async (direction: 1 | -1) => {
      present(Math.max(0, Math.min(4000, timeMs + direction * 1000)));
    }),
    subscribe: (signal, listener) => {
      listeners.get(signal)?.add(listener);
      return () => listeners.get(signal)?.delete(listener);
    },
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
    present,
    samples,
    scrub: engine.scrub as ReturnType<typeof vi.fn>,
    setPlaybackRate: engine.setPlaybackRate as ReturnType<typeof vi.fn>,
    setSeeking(next: boolean) {
      seeking = next;
      announce("seeking");
    },
    setStatus(next: PresentedFrameChannelStatus) {
      status = next;
      announce("state");
    },
    setTimeMs(next: number) {
      present(next);
    },
    source,
    step: engine.step as ReturnType<typeof vi.fn>,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createScene(
  overrides: Partial<MediaRendererScene> = {},
): MediaRendererScene {
  return {
    destroy: vi.fn(),
    initializeMedia: vi.fn(),
    presentSample: vi.fn(() => ({
      activeDetectionCount: 0,
      activeDetectionFrameIndex: null,
      activeDetectionFrameTime: null,
      detectionBuffer: createIdleDetectionBufferState(),
      drawnMaskFrameTime: null,
      maskHeldStale: false,
      mediaTime: 0,
      presentedFrameSerial: 1,
    })),
    rendererBackend: "test",
    setPresentation: vi.fn(),
    setRenderQuality: vi.fn(),
    setTimelineContext: vi.fn(),
    ...overrides,
  };
}
