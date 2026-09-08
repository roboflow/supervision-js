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
  it("returns the displayed indexed frame and observable scrub outcome without pulling samples", async () => {
    const producer = createProducer();
    const clock = {
      frameCount: 4,
      firstTimestamp: 0,
      endTimestamp: 4,
      duration: 4,
      timeAt: (index: number) => index,
      durationAt: () => 1,
      indexAtOrBefore: (time: number) =>
        Math.min(3, Math.max(0, Math.floor(time))),
    };
    const painted: number[] = [];
    const renderer = await createRenderer(
      producer,
      createScene(),
      {
        source: {
          open: async () => ({ ...producer.source, frameClock: clock }),
        },
      },
      (frame) => {
        painted.push(frame.frameId.index);
        frame.acknowledgePresentation?.();
        frame.frame.close();
      },
    );
    const navigation = renderer.frameNavigation;
    expect(navigation).toBeDefined();
    expect(await navigation!.moveToFrame(3)).toEqual({
      index: 3,
      mediaTime: 3,
      duration: 1,
    });
    expect(painted.at(-1)).toBe(3);
    const older = navigation!.scrubToFrame(1);
    const current = navigation!.scrubToTime(2.4);
    expect(await older.settled).toEqual({ status: "superseded" });
    producer.present(2000);
    expect(await current.settled).toEqual({
      status: "landed",
      frame: { index: 2, mediaTime: 2, duration: 1 },
    });
    const cancelled = navigation!.scrubToFrame(1);
    renderer.pause();
    expect(await cancelled.settled).toEqual({ status: "superseded" });
    expect(producer.getSample).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("keeps an exact move pending while its frame waits for the scene to draw", async () => {
    const producer = createProducer();
    const clock = {
      frameCount: 4,
      firstTimestamp: 0,
      endTimestamp: 4,
      duration: 4,
      timeAt: (index: number) => index,
      durationAt: () => 1,
      indexAtOrBefore: (time: number) =>
        Math.min(3, Math.max(0, Math.floor(time))),
    };
    let pending: PresentedVideoFrame | undefined;
    const renderer = await createRenderer(
      producer,
      createScene(),
      {
        source: {
          open: async () => ({ ...producer.source, frameClock: clock }),
        },
      },
      (frame) => {
        if (frame.frameId.index === 0) {
          frame.acknowledgePresentation?.();
          frame.frame.close();
        } else pending = frame;
      },
    );
    let settled = false;
    const moving = renderer.frameNavigation!.moveToFrame(3).then((frame) => {
      settled = true;
      return frame;
    });
    await vi.waitFor(() => expect(pending).toBeDefined());
    await Promise.resolve();
    expect(settled).toBe(false);

    pending!.acknowledgePresentation?.();
    pending!.frame.close();
    await expect(moving).resolves.toEqual({
      index: 3,
      mediaTime: 3,
      duration: 1,
    });
    renderer.destroy();
  });

  it("settles a pending frame scrub when the producer enters Error", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      source: {
        open: async () => ({
          ...producer.source,
          frameClock: {
            duration: 4,
            durationAt: () => 1,
            endTimestamp: 4,
            firstTimestamp: 0,
            frameCount: 4,
            indexAtOrBefore: (time: number) =>
              Math.min(3, Math.max(0, Math.floor(time))),
            timeAt: (index: number) => index,
          },
        }),
      },
    });
    const scrub = renderer.frameNavigation!.scrubToFrame(2);
    let outcome: Awaited<typeof scrub.settled> | "pending" = "pending";
    void scrub.settled.then((settled) => {
      outcome = settled;
    });

    producer.setStatus("ERRORED");
    await Promise.resolve();

    expect(outcome).toEqual({ status: "superseded" });
    renderer.destroy();
  });

  it("terminates frame navigation started after the producer enters Error", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      source: {
        open: async () => ({
          ...producer.source,
          frameClock: {
            duration: 4,
            durationAt: () => 1,
            endTimestamp: 4,
            firstTimestamp: 0,
            frameCount: 4,
            indexAtOrBefore: (time: number) =>
              Math.min(3, Math.max(0, Math.floor(time))),
            timeAt: (index: number) => index,
          },
        }),
      },
    });
    const navigation = renderer.frameNavigation!;
    producer.setStatus("ERRORED");

    await expect(navigation.moveToFrame(2)).rejects.toThrow(
      "Media playback failed.",
    );
    expect(() => navigation.scrubToFrame(2)).toThrow("Media playback failed.");
    renderer.destroy();
  });

  it("terminates frame navigation started after renderer destruction", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      source: {
        open: async () => ({
          ...producer.source,
          frameClock: {
            duration: 4,
            durationAt: () => 1,
            endTimestamp: 4,
            firstTimestamp: 0,
            frameCount: 4,
            indexAtOrBefore: (time: number) =>
              Math.min(3, Math.max(0, Math.floor(time))),
            timeAt: (index: number) => index,
          },
        }),
      },
    });
    const navigation = renderer.frameNavigation!;

    renderer.destroy();

    await expect(navigation.moveToFrame(2)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(() => navigation.scrubToFrame(2)).toThrow(
      "Media frame navigation was destroyed.",
    );
  });

  it("settles an indexed scrub from the exact frame the scene already accepted", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      source: {
        open: async () => ({
          ...producer.source,
          frameClock: {
            duration: 4,
            durationAt: () => 1,
            endTimestamp: 4,
            firstTimestamp: 0,
            frameCount: 4,
            indexAtOrBefore: (time: number) =>
              Math.min(3, Math.max(0, Math.floor(time))),
            timeAt: (index: number) => index,
          },
        }),
      },
    });

    const scrub = renderer.frameNavigation!.scrubToFrame(0);

    await expect(scrub.settled).resolves.toEqual({
      frame: { duration: 1, index: 0, mediaTime: 0 },
      status: "landed",
    });
    expect(producer.scrub).toHaveBeenLastCalledWith(0, "gesture");
    expect(producer.getSample).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("settles an indexed move when the producer retains the accepted current frame", async () => {
    const producer = createProducer();
    const renderer = await createRenderer(producer, createScene(), {
      source: {
        open: async () => ({
          ...producer.source,
          frameClock: {
            duration: 4,
            durationAt: () => 1,
            endTimestamp: 4,
            firstTimestamp: 0,
            frameCount: 4,
            indexAtOrBefore: (time: number) =>
              Math.min(3, Math.max(0, Math.floor(time))),
            timeAt: (index: number) => index,
          },
        }),
      },
    });
    producer.commit.mockImplementationOnce(async () => undefined);

    await expect(renderer.frameNavigation!.moveToFrame(0)).resolves.toEqual({
      duration: 1,
      index: 0,
      mediaTime: 0,
    });
    expect(producer.commit).toHaveBeenLastCalledWith(0);
    renderer.destroy();
  });

  it("exposes display resizing only when the push source supports it", async () => {
    const capableProducer = createProducer();
    const setDisplay = vi.fn(async () => false);
    const capable = await createRenderer(capableProducer, createScene(), {
      source: {
        open: async () => ({ ...capableProducer.source, setDisplay }),
      },
    });
    const unsupported = await createRenderer(createProducer(), createScene());
    const display = {
      boxHeight: 360,
      boxWidth: 640,
      devicePixelRatio: 2,
      maxDevicePixelRatio: 2,
    };

    expect(capable.setDisplay).toBeTypeOf("function");
    expect(unsupported.setDisplay).toBeUndefined();
    await capable.setDisplay!(display);
    expect(setDisplay).toHaveBeenCalledExactlyOnceWith(display);

    capable.destroy();
    unsupported.destroy();
  });

  it("settles a changed display resize only after its guarded replacement reaches the scene", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    preparation.cover();
    const displayed: number[] = [];
    let replacement: ReturnType<typeof producer.present> | undefined;
    const setDisplay = vi.fn(async () => {
      replacement = producer.present(1000);
      return true;
    });
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      {
        renderPreparation: { playbackGate: { enabled: true } },
        source: {
          open: async () => ({ ...producer.source, setDisplay }),
        },
      },
      (presented) => {
        displayed.push(presented.paintSeq);
        presented.acknowledgePresentation?.();
        presented.frame.close();
      },
    );
    producer.present(1000);
    preparation.stall();
    let settled = false;

    const resizing = renderer.setDisplay!({
      boxHeight: 360,
      boxWidth: 640,
      devicePixelRatio: 2,
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(preparation.waitForRenderPreparation).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ enabled: true }),
        expect.any(AbortSignal),
      ),
    );

    expect({ displayed, settled }).toEqual({
      displayed: [1, 2],
      settled: false,
    });
    expect(replacement?.frame.close).not.toHaveBeenCalled();

    preparation.prepare();
    await resizing;

    expect(displayed).toEqual([1, 2, 3]);
    expect(replacement?.frame.close).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it.each([false, true])(
    "opens with real pixels before future detections arrive (autoplay %s)",
    async (autoPlay) => {
      vi.useFakeTimers();
      const producer = createProducer();
      const coverage = createDeferred<void>();
      let available = false;
      const source: DetectionFrameSource = {
        getAvailableRanges: () =>
          available ? [{ startTime: 0, endTime: 4 }] : [],
        loadFrames: async () =>
          available ? [{ mediaTime: 0, endTime: 4, detections: [] }] : [],
        waitForRange: () => coverage.promise,
      };
      let opened: Awaited<ReturnType<typeof createRenderer>> | undefined;
      const paint = vi.fn((frame: PresentedVideoFrame) => {
        frame.acknowledgePresentation?.();
        frame.frame.close();
      });
      const opening = createRenderer(
        producer,
        createScene(),
        {
          autoPlay,
          detectionSource: source,
          detectionBuffer: {
            playbackGate: { enabled: true, maxWaitSeconds: Infinity },
          },
        },
        paint,
      ).then((renderer) => {
        opened = renderer;
        return renderer;
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(opened).toBeDefined();
        expect(paint).toHaveBeenCalledOnce();
        expect(producer.play).not.toHaveBeenCalled();
        expect(opened!.getState().playbackState).toBe(
          autoPlay
            ? MediaRendererPlaybackState.Buffering
            : MediaRendererPlaybackState.Ready,
        );
        available = true;
        coverage.resolve();
        await vi.advanceTimersByTimeAsync(100);
        if (autoPlay) expect(producer.play).toHaveBeenCalledOnce();
        else {
          await opened!.play();
          expect(producer.play).toHaveBeenCalledOnce();
        }
      } finally {
        available = true;
        coverage.resolve();
        await vi.advanceTimersByTimeAsync(100);
        (await opening).destroy();
        vi.useRealTimers();
      }
    },
  );

  it("ignores a failed autoplay wait after the viewer has paused", async () => {
    const producer = createProducer();
    const coverage = createDeferred<void>();
    const source: DetectionFrameSource = {
      getAvailableRanges: () => [],
      loadFrames: async () => [],
      waitForRange: vi.fn(() => coverage.promise),
    };
    const renderer = await createRenderer(producer, createScene(), {
      autoPlay: true,
      detectionSource: source,
      detectionBuffer: {
        playbackGate: { enabled: true, maxWaitSeconds: Infinity },
      },
    });
    await vi.waitFor(() => expect(source.waitForRange).toHaveBeenCalled());
    renderer.pause();
    producer.setStatus("PAUSED");
    coverage.reject(new Error("obsolete autoplay coverage failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );
    expect(producer.play).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("reports a failed autoplay wait while that play is still current", async () => {
    const producer = createProducer();
    const coverage = createDeferred<void>();
    const source: DetectionFrameSource = {
      getAvailableRanges: () => [],
      loadFrames: async () => [],
      waitForRange: vi.fn(() => coverage.promise),
    };
    const renderer = await createRenderer(producer, createScene(), {
      autoPlay: true,
      detectionSource: source,
      detectionBuffer: {
        playbackGate: { enabled: true, maxWaitSeconds: Infinity },
      },
    });
    await vi.waitFor(() => expect(source.waitForRange).toHaveBeenCalled());

    coverage.reject(new Error("current autoplay coverage failed"));

    await vi.waitFor(() =>
      expect(renderer.getState()).toMatchObject({
        playbackState: MediaRendererPlaybackState.Error,
        source: { errorMessage: "current autoplay coverage failed" },
      }),
    );
    expect(producer.play).not.toHaveBeenCalled();
    renderer.destroy();
  });

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

  it.each([
    {
      duration: 10.25,
      expectedTime: 10.25,
      firstTimestamp: 0.25,
      name: "the absolute endpoint of offset media",
      requestedTime: 99,
    },
    {
      duration: 10,
      expectedTime: 10,
      firstTimestamp: 0,
      name: "the endpoint of zero-origin media",
      requestedTime: 99,
    },
    {
      duration: null,
      expectedTime: 99,
      firstTimestamp: 0.25,
      name: "the request when the endpoint is unknown",
      requestedTime: 99,
    },
    {
      duration: 10.25,
      expectedTime: 0.25,
      firstTimestamp: 0.25,
      name: "the first timestamp for a below-origin request",
      requestedTime: 0,
    },
  ])("sends seek and scrub to $name", async (testCase) => {
    const producer = createProducer();
    const source = {
      ...producer.source,
      metadata: {
        ...producer.source.metadata,
        duration: testCase.duration,
        firstTimestamp: testCase.firstTimestamp,
      },
    };
    const renderer = await createRenderer(producer, createScene(), {
      source: { open: async () => source },
    });

    await renderer.seek(testCase.requestedTime);
    renderer.scrub(testCase.requestedTime);

    expect(producer.commit).toHaveBeenCalledExactlyOnceWith(
      testCase.expectedTime * 1000,
    );
    expect(producer.scrub).toHaveBeenCalledExactlyOnceWith(
      testCase.expectedTime * 1000,
      "gesture",
    );
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

  it("refreshes the picture actually displayed after a delayed detection load", async () => {
    const producer = createProducer();
    const pending = createDeferred<readonly DetectionFrame[]>();
    const frames = [0, 1].map((mediaTime) => ({
      detections: [],
      frameIndex: mediaTime,
      mediaTime,
    }));
    let version = 0;
    const source: DetectionFrameSource = {
      getVersion: () => version,
      loadFrames: vi.fn(() =>
        version === 0 ? Promise.resolve(frames) : pending.promise,
      ),
    };
    const scene = createScene();
    const renderer = await createMediaRendererCore(
      {
        container: {} as HTMLElement,
        source: { open: async () => producer.source },
        detectionSource: source,
        detectionBuffer: {
          bufferAheadSeconds: 4,
          playbackGate: { enabled: false },
        },
        renderPreparation: { playbackGate: { enabled: false } },
      },
      {
        openMediaSource: vi.fn(),
        createScene: async (options) => {
          options.presentedFrames?.onPresentedFrame((presented) => {
            options.onPresentationUpdate?.({
              activeDetectionCount: 0,
              activeDetectionFrameIndex: null,
              activeDetectionFrameTime: null,
              detectionBuffer: createIdleDetectionBufferState(),
              drawnMaskFrameTime: null,
              maskHeldStale: false,
              mediaTime: presented.mediaTimeS,
              presentedFrameSerial: presented.paintSeq,
            });
            presented.acknowledgePresentation?.();
            presented.frame.close();
          });
          return scene;
        },
      },
    );
    await vi.waitFor(() =>
      expect(renderer.getState().detectionBuffer.status).toBe("ready"),
    );
    expect(renderer.getState().presentedTime).toBe(0);
    const loads = vi.mocked(source.loadFrames).mock.calls.length;
    version += 1;
    const refresh = renderer.refresh();
    await vi.waitFor(() =>
      expect(source.loadFrames).toHaveBeenCalledTimes(loads + 1),
    );

    producer.present(1000);
    expect(renderer.getState().presentedTime).toBe(1);
    pending.resolve(frames);
    await refresh;

    expect(scene.setPresentation).toHaveBeenLastCalledWith(
      expect.anything(),
      1,
    );
    expect(producer.commit).toHaveBeenCalledTimes(1);
    expect(producer.getSample).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("does not stop the producer while an in-range detection revision is loading", async () => {
    const producer = createProducer();
    const pendingRevision = createDeferred<readonly DetectionFrame[]>();
    let version = 0;
    const source: DetectionFrameSource = {
      getAvailableRanges: () => [{ endTime: 4, startTime: 0 }],
      getChangesSince: (committedVersion) => ({
        ranges:
          committedVersion < version ? [{ endTime: 2, startTime: 0 }] : [],
        requiresReload: false,
        version,
      }),
      getVersion: () => version,
      loadFrames: vi.fn(() =>
        version === 0
          ? Promise.resolve([
              {
                detections: [{ id: "old" }],
                endTime: 4,
                frameIndex: 0,
                mediaTime: 0,
              },
            ])
          : pendingRevision.promise,
      ),
      waitForRange: vi.fn(async () => undefined),
    };
    const renderer = await createRenderer(producer, createScene(), {
      detectionBuffer: {
        bufferAheadSeconds: 4,
        bufferBehindSeconds: 0,
        playbackGate: { enabled: true },
      },
      detectionSource: source,
    });
    await vi.waitFor(() =>
      expect(renderer.getState().detectionBuffer).toMatchObject({
        bufferEndTime: 4,
        status: "ready",
      }),
    );
    const committedLoadCount = vi.mocked(source.loadFrames).mock.calls.length;
    version += 1;

    const presented = producer.present(1000);
    await vi.waitFor(() =>
      expect(source.loadFrames).toHaveBeenCalledTimes(committedLoadCount + 1),
    );

    try {
      await vi.waitFor(() =>
        expect(presented.frame.close).toHaveBeenCalledOnce(),
      );
      expect(producer.beginInteractiveSeek).not.toHaveBeenCalled();
      expect(producer.endInteractiveSeek).not.toHaveBeenCalled();
      expect(renderer.getState().playbackState).toBe(
        MediaRendererPlaybackState.Ready,
      );
    } finally {
      pendingRevision.resolve([
        {
          detections: [{ id: "new" }],
          endTime: 4,
          frameIndex: 0,
          mediaTime: 0,
        },
      ]);
    }
    await vi.waitFor(() =>
      expect(renderer.getState().detectionBuffer.detectionCount).toBe(1),
    );

    expect(producer.beginInteractiveSeek).not.toHaveBeenCalled();
    expect(producer.endInteractiveSeek).not.toHaveBeenCalled();
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
        presented.acknowledgePresentation?.();
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
        presented.acknowledgePresentation?.();
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

  it("resumes a gated producer only after the scene acknowledges its ready frame", async () => {
    const producer = createProducer();
    const preparation = createStuckRenderPreparation();
    let awaitingPresentation: PresentedVideoFrame | undefined;
    const renderer = await createRenderer(
      producer,
      createScene(preparation.scene),
      { renderPreparation: { playbackGate: { enabled: true } } },
      (presented) => {
        if (presented.mediaTimeS === 0) {
          presented.acknowledgePresentation?.();
          presented.frame.close();
        } else {
          awaitingPresentation = presented;
        }
      },
    );

    producer.setStatus("PLAYING");
    producer.setTimeMs(1000);
    preparation.prepare();

    await vi.waitFor(() => expect(awaitingPresentation).toBeDefined());
    expect(producer.endInteractiveSeek).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Buffering,
    );

    awaitingPresentation!.acknowledgePresentation?.();
    awaitingPresentation!.frame.close();
    await vi.waitFor(() => {
      expect(producer.endInteractiveSeek).toHaveBeenCalledOnce();
      expect(renderer.getState().playbackState).toBe(
        MediaRendererPlaybackState.Playing,
      );
    });
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
  presentFrame: (presented: PresentedVideoFrame) => void = (presented) => {
    presented.acknowledgePresentation?.();
    presented.frame.close();
  },
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
