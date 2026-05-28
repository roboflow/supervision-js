import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  createMockSample,
  createRenderer,
  domMock,
  flushAnimationFrame,
  mediaMock,
  type MockVideoSample,
  pixiMock,
  resetMocks,
} from "../test/media-renderer-harness";

type PackageEntrypoint = typeof import("./index");

let MediaRendererPlaybackState: PackageEntrypoint["MediaRendererPlaybackState"];
let MediaSourceStatus: PackageEntrypoint["MediaSourceStatus"];

describe("package entrypoint", () => {
  beforeAll(async () => {
    const entrypoint = await import("./index");

    MediaRendererPlaybackState = entrypoint.MediaRendererPlaybackState;
    MediaSourceStatus = entrypoint.MediaSourceStatus;
  });

  it("exposes the media renderer and public renderer enums", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "MediaRendererFit",
      "MediaRendererPlaybackState",
      "MediaSourceStatus",
      "createMediaRenderer",
    ]);
    expect(entrypoint.createMediaRenderer).toEqual(expect.any(Function));
    expect(entrypoint.MediaRendererFit).toEqual({
      Contain: "contain",
      Cover: "cover",
    });
    expect(entrypoint.MediaRendererPlaybackState).toEqual({
      Destroyed: "destroyed",
      Error: "error",
      Loading: "loading",
      Paused: "paused",
      Playing: "playing",
      Ready: "ready",
    });
    expect(entrypoint.MediaSourceStatus).toEqual({
      Destroyed: "destroyed",
      Error: "error",
      Loading: "loading",
      Ready: "ready",
    });
  });

  it("keeps renderer orchestration provider-agnostic behind default adapters", async () => {
    const fsModuleName = "node:fs/promises";
    const { readFile } = (await import(fsModuleName)) as {
      readFile(path: URL, encoding: "utf8"): Promise<string>;
    };
    const defaultFactorySource = await readFile(
      new URL("./renderers/media-renderer.ts", import.meta.url),
      "utf8",
    );
    const coreSource = await readFile(
      new URL("./renderers/media-renderer-core.ts", import.meta.url),
      "utf8",
    );

    expect(defaultFactorySource).toContain("openMediabunnyMediaSource");
    expect(defaultFactorySource).toContain("createPixiMediaScene");
    expect(defaultFactorySource).toContain("createMediaRendererCore");
    expect(coreSource).toContain("createMediaPlaybackController");
    expect(coreSource).not.toContain("openMediabunnyMediaSource");
    expect(coreSource).not.toContain("createPixiMediaScene");
    expect(coreSource).not.toContain('"pixi.js"');
    expect(coreSource).not.toContain('"mediabunny"');
  });

  it("uses Mediabunny and does not create a video element", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);

    expect(domMock.createElement).toHaveBeenCalledWith("canvas");
    expect(
      domMock.createElement.mock.calls.some(([tagName]) => tagName === "video"),
    ).toBe(false);
    expect(mediaMock.urlSourceConstructor).toHaveBeenCalledWith("sample.mp4");
    expect(mediaMock.inputConstructor).toHaveBeenCalledWith({
      formats: [
        { name: "MP4" },
        { name: "QuickTime" },
        { name: "WebM" },
        { name: "Matroska" },
      ],
      source: expect.any(Object),
    });
    expect(mediaMock.videoSampleSinkConstructor).toHaveBeenCalledWith(
      mediaMock.primaryVideoTrack,
    );

    renderer.destroy();
  });

  it("draws the first decoded sample during create without starting playback", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);

    expect(mediaMock.samplesCallStarts).toEqual([0]);
    expect(mediaMock.iteratorReturn).toHaveBeenCalledOnce();
    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samples[0].draw).toHaveBeenCalledOnce();
    expect(mediaMock.samples[0].close).toHaveBeenCalledOnce();
    expect(pixiMock.canvasSourceUpdate).toHaveBeenCalledOnce();
    expect(domMock.requestAnimationFrame).not.toHaveBeenCalled();
    expect(renderer.getState()).toMatchObject({
      currentTime: 0,
      mediaHeight: 720,
      mediaWidth: 1280,
      playbackState: MediaRendererPlaybackState.Ready,
      presentedFrames: 1,
    });

    renderer.destroy();
  });

  it("play requests a later media timestamp and draws that sample", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];

    const renderer = await createRenderer(false, false);
    mediaMock.getSample.mockClear();
    await renderer.play();
    await vi.waitFor(() => {
      expect(domMock.requestAnimationFrame).toHaveBeenCalledOnce();
    });

    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.getSample).toHaveBeenCalledOnce();
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    const [requestedMediaTime, options] = mediaMock.getSample.mock.calls[0];
    expect(requestedMediaTime).toBeCloseTo(0.04);
    expect(options).toEqual({ skipLiveWait: true });
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      presentedFrames: 2,
    });
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    renderer.destroy();
  });

  it("closes duplicate samples without counting them as presented", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    mediaMock.getSample.mockResolvedValueOnce(mediaMock.samples[0]);
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].close).toHaveBeenCalledTimes(2);
    });

    expect(renderer.getState()).toMatchObject({
      currentTime: 0,
      presentedFrames: 1,
    });
    expect(mediaMock.samples[0].draw).toHaveBeenCalledOnce();
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();

    renderer.destroy();
  });

  it("selects overlay frames from decoded sample timestamps", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const onFrame = vi.fn();
    const renderer = await createRenderer(false, false, {
      onFrame,
      overlayFrames: [
        {
          mediaTime: 0.07,
          rects: [
            {
              height: 40,
              strokeColor: 0xff0000,
              width: 30,
              x: 20,
              y: 10,
            },
          ],
        },
        {
          mediaTime: 0.04,
          rects: [
            {
              height: 20,
              strokeAlpha: 0.5,
              strokeWidth: 4,
              width: 10,
              x: 4,
              y: 5,
            },
          ],
        },
      ],
    });
    const overlayGraphics = pixiMock.graphicsInstances[0];

    expect(overlayGraphics.rect).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOverlayFrameTime: null,
        activeOverlayRectCount: 0,
        mediaTime: 0,
      }),
    );

    mediaMock.getSample.mockClear();
    await renderer.play();
    flushAnimationFrame(70);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    const [requestedMediaTime] = mediaMock.getSample.mock.calls[0];
    expect(requestedMediaTime).toBeCloseTo(0.07);
    expect(overlayGraphics.clear).toHaveBeenCalledTimes(2);
    expect(overlayGraphics.rect).toHaveBeenLastCalledWith(4, 5, 10, 20);
    expect(overlayGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x00ff66,
      width: 4,
    });
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0.04,
      activeOverlayRectCount: 1,
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[2].draw).toHaveBeenCalledOnce();
    });

    expect(overlayGraphics.rect).toHaveBeenLastCalledWith(20, 10, 30, 40);
    expect(overlayGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 1,
      color: 0xff0000,
      width: 2,
    });
    expect(onFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeOverlayFrameTime: 0.07,
        activeOverlayRectCount: 1,
        mediaTime: 0.08,
      }),
    );

    renderer.destroy();
  });

  it("presents the first sample and first overlay again at a loop boundary", async () => {
    resetMocks();
    mediaMock.getDurationFromMetadata.mockResolvedValue(0.08);
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];

    const renderer = await createRenderer(false, true, {
      overlayFrames: [
        {
          mediaTime: 0,
          rects: [{ height: 20, width: 10, x: 4, y: 5 }],
        },
        {
          mediaTime: 0.04,
          rects: [{ height: 40, width: 30, x: 20, y: 10 }],
        },
      ],
    });

    mediaMock.getSample.mockClear();
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0.04,
      activeOverlayRectCount: 1,
      currentTime: 0.04,
      presentedFrames: 2,
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].draw).toHaveBeenCalledTimes(2);
    });

    expect(mediaMock.getSample).toHaveBeenLastCalledWith(0, {
      skipLiveWait: true,
    });
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0,
      activeOverlayRectCount: 1,
      currentTime: 0,
      presentedFrames: 3,
    });

    renderer.destroy();
  });

  it("does not redraw overlays or update overlay diagnostics for duplicate samples", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      overlayFrames: [
        {
          mediaTime: 0,
          rects: [{ height: 20, width: 10, x: 4, y: 5 }],
        },
        {
          mediaTime: 0.04,
          rects: [{ height: 40, width: 30, x: 20, y: 10 }],
        },
      ],
    });
    const overlayGraphics = pixiMock.graphicsInstances[0];
    const initialOverlayRectCalls = overlayGraphics.rect.mock.calls.length;
    const initialOverlayClearCalls = overlayGraphics.clear.mock.calls.length;

    mediaMock.getSample.mockResolvedValueOnce(mediaMock.samples[0]);
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].close).toHaveBeenCalledTimes(2);
    });

    expect(overlayGraphics.rect).toHaveBeenCalledTimes(initialOverlayRectCalls);
    expect(overlayGraphics.clear).toHaveBeenCalledTimes(
      initialOverlayClearCalls,
    );
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0,
      activeOverlayRectCount: 1,
      currentTime: 0,
      presentedFrames: 1,
    });

    renderer.destroy();
  });

  it("does not redraw overlays when presented samples stay within the same active overlay frame", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.02, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const renderer = await createRenderer(false, false, {
      overlayFrames: [
        {
          mediaTime: 0,
          rects: [{ height: 20, width: 10, x: 4, y: 5 }],
        },
        {
          mediaTime: 0.08,
          rects: [{ height: 40, width: 30, x: 20, y: 10 }],
        },
      ],
    });
    const overlayGraphics = pixiMock.graphicsInstances[0];

    expect(overlayGraphics.clear).toHaveBeenCalledOnce();
    expect(overlayGraphics.rect).toHaveBeenCalledOnce();
    expect(overlayGraphics.stroke).toHaveBeenCalledOnce();

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(overlayGraphics.clear).toHaveBeenCalledOnce();
    expect(overlayGraphics.rect).toHaveBeenCalledOnce();
    expect(overlayGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0,
      activeOverlayRectCount: 1,
      currentTime: 0.02,
      presentedFrames: 2,
    });

    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[2].draw).toHaveBeenCalledOnce();
    });

    expect(overlayGraphics.clear).toHaveBeenCalledOnce();
    expect(overlayGraphics.rect).toHaveBeenCalledOnce();
    expect(overlayGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0,
      activeOverlayRectCount: 1,
      currentTime: 0.04,
      presentedFrames: 3,
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[3].draw).toHaveBeenCalledOnce();
    });

    expect(overlayGraphics.clear).toHaveBeenCalledTimes(2);
    expect(overlayGraphics.rect).toHaveBeenCalledTimes(2);
    expect(overlayGraphics.stroke).toHaveBeenCalledTimes(2);
    expect(overlayGraphics.rect).toHaveBeenLastCalledWith(20, 10, 30, 40);
    expect(renderer.getState()).toMatchObject({
      activeOverlayFrameTime: 0.08,
      activeOverlayRectCount: 1,
      currentTime: 0.08,
      presentedFrames: 4,
    });

    renderer.destroy();
  });

  it("does not overlap decode requests while getSample is in flight", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await renderer.play();
    flushAnimationFrame(40);

    expect(mediaMock.getSample).toHaveBeenCalledOnce();
    expect(domMock.rafCallbacks).toHaveLength(0);

    deferred.resolve(mediaMock.samples[1]);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
      expect(domMock.rafCallbacks).toHaveLength(1);
    });

    renderer.destroy();
  });

  it("pause prevents late async samples from drawing", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await renderer.play();
    flushAnimationFrame(40);
    renderer.pause();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    renderer.destroy();
  });

  it("destroy prevents late async samples from drawing", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await renderer.play();
    flushAnimationFrame(40);
    renderer.destroy();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Destroyed,
    );
  });

  it("cleans up scheduled frames, media input, and Pixi on destroy", async () => {
    resetMocks();

    const renderer = await createRenderer(false);
    await renderer.play();
    renderer.destroy();

    expect(domMock.cancelAnimationFrame).toHaveBeenCalled();
    expect(mediaMock.dispose).toHaveBeenCalledOnce();
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Destroyed,
    );
  });

  it("puts the renderer in error state when Mediabunny decode setup fails", async () => {
    resetMocks();
    mediaMock.getPrimaryVideoTrack.mockRejectedValue(
      new Error("decode failed"),
    );

    const renderer = await createRenderer(false);

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Error,
    );
    expect(renderer.getState().source).toMatchObject({
      errorMessage: "decode failed",
      status: MediaSourceStatus.Error,
    });
    expect(pixiMock.stageAddChild).not.toHaveBeenCalled();

    renderer.destroy();
  });
});
