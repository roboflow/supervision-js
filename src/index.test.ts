import { describe, expect, it, vi } from "vitest";

type MockVideoSample = {
  close: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  duration: number;
  timestamp: number;
};

function createMockSample(timestamp: number, duration = 0.04): MockVideoSample {
  return {
    close: vi.fn(),
    draw: vi.fn(),
    duration,
    timestamp,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}

const pixiMock = vi.hoisted(() => ({
  appDestroy: vi.fn(),
  appInit: vi.fn(async () => undefined),
  canvasSourceOptions: [] as unknown[],
  canvasSourceUpdate: vi.fn(),
  stageAddChild: vi.fn(),
  tickerAdd: vi.fn(),
  tickerRemove: vi.fn(),
  textureOptions: [] as unknown[],
}));

const mediaMock = vi.hoisted(() => ({
  audioTracks: [{ type: "audio" }],
  canRead: vi.fn(async () => true),
  dispose: vi.fn(),
  format: { mimeType: "video/mp4", name: "MP4" },
  getAudioTracks: vi.fn(async () => mediaMock.audioTracks),
  getDisplayHeight: vi.fn(async () => 720),
  getDisplayWidth: vi.fn(async () => 1280),
  getDurationFromMetadata: vi.fn(async () => 1),
  getFirstTimestamp: vi.fn(async () => 0),
  getFormat: vi.fn(async () => mediaMock.format),
  getMimeType: vi.fn(async () => 'video/mp4; codecs="avc1.42e01e"'),
  getPrimaryVideoTrack: vi.fn(async () => mediaMock.primaryVideoTrack),
  getSample: vi.fn(),
  getTracks: vi.fn(async () => mediaMock.tracks),
  getVideoTracks: vi.fn(async () => mediaMock.videoTracks),
  inputConstructor: vi.fn(),
  iteratorReturn: vi.fn(async () => undefined),
  primaryVideoTrack: {} as Record<string, unknown>,
  samples: [] as MockVideoSample[],
  samplesCallStarts: [] as Array<number | undefined>,
  tracks: [{ type: "video" }, { type: "audio" }],
  urlSourceConstructor: vi.fn(),
  videoSampleSinkConstructor: vi.fn(),
  videoTracks: [{ type: "video" }],
}));

const domMock = vi.hoisted(() => ({
  appendChild: vi.fn(),
  cancelAnimationFrame: vi.fn(),
  createElement: vi.fn(),
  getContext: vi.fn(),
  performanceNow: vi.fn(() => 0),
  rafCallbacks: [] as FrameRequestCallback[],
  requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
    domMock.rafCallbacks.push(callback);
    return domMock.rafCallbacks.length;
  }),
}));

vi.mock("pixi.js", () => {
  class Application {
    canvas = { style: {} };
    screen = { height: 360, width: 640 };
    stage = { addChild: pixiMock.stageAddChild };
    ticker = { add: pixiMock.tickerAdd, remove: pixiMock.tickerRemove };
    destroy = pixiMock.appDestroy;
    init = pixiMock.appInit;
  }

  class CanvasSource {
    update = pixiMock.canvasSourceUpdate;

    constructor(options: unknown) {
      pixiMock.canvasSourceOptions.push(options);
    }
  }

  class Texture {
    constructor(options: unknown) {
      pixiMock.textureOptions.push(options);
    }

    update = vi.fn();
  }

  class Sprite {
    anchor = { set: vi.fn() };
    height = 0;
    position = { set: vi.fn() };
    width = 0;

    constructor(public readonly options: unknown) {}
  }

  return { Application, CanvasSource, Sprite, Texture };
});

vi.mock("mediabunny", () => {
  class Input {
    constructor(options: unknown) {
      mediaMock.inputConstructor(options);
    }

    canRead = mediaMock.canRead;
    dispose = mediaMock.dispose;
    getAudioTracks = mediaMock.getAudioTracks;
    getDurationFromMetadata = mediaMock.getDurationFromMetadata;
    getFormat = mediaMock.getFormat;
    getMimeType = mediaMock.getMimeType;
    getPrimaryVideoTrack = mediaMock.getPrimaryVideoTrack;
    getTracks = mediaMock.getTracks;
    getVideoTracks = mediaMock.getVideoTracks;
  }

  class UrlSource {
    constructor(url: string) {
      mediaMock.urlSourceConstructor(url);
    }
  }

  class VideoSampleSink {
    constructor(track: unknown) {
      mediaMock.videoSampleSinkConstructor(track);
    }

    getSample(timestamp: number, options?: unknown) {
      return mediaMock.getSample(timestamp, options);
    }

    samples(startTimestamp?: number) {
      mediaMock.samplesCallStarts.push(startTimestamp);
      let index = mediaMock.samples.findIndex(
        (sample) =>
          startTimestamp === undefined || sample.timestamp >= startTimestamp,
      );

      if (index < 0) {
        index = mediaMock.samples.length;
      }

      return {
        async next() {
          if (index >= mediaMock.samples.length) {
            return { done: true as const, value: undefined };
          }

          return { done: false as const, value: mediaMock.samples[index++] };
        },
        return: mediaMock.iteratorReturn,
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }

  return {
    Input,
    MATROSKA: { name: "Matroska" },
    MP4: { name: "MP4" },
    QTFF: { name: "QuickTime" },
    UrlSource,
    VideoSampleSink,
    WEBM: { name: "WebM" },
  };
});

vi.stubGlobal("document", {
  createElement: domMock.createElement,
});

vi.stubGlobal("window", {
  cancelAnimationFrame: domMock.cancelAnimationFrame,
  devicePixelRatio: 1,
  requestAnimationFrame: domMock.requestAnimationFrame,
});

vi.stubGlobal("performance", {
  now: domMock.performanceNow,
});

describe("package entrypoint", () => {
  function resetMocks() {
    pixiMock.appDestroy.mockClear();
    pixiMock.appInit.mockClear();
    pixiMock.appInit.mockResolvedValue(undefined);
    pixiMock.canvasSourceOptions.length = 0;
    pixiMock.canvasSourceUpdate.mockClear();
    pixiMock.stageAddChild.mockClear();
    pixiMock.tickerAdd.mockClear();
    pixiMock.tickerRemove.mockClear();
    pixiMock.textureOptions.length = 0;
    mediaMock.audioTracks = [{ type: "audio" }];
    mediaMock.canRead.mockClear();
    mediaMock.canRead.mockResolvedValue(true);
    mediaMock.dispose.mockClear();
    mediaMock.format = { mimeType: "video/mp4", name: "MP4" };
    mediaMock.getAudioTracks.mockClear();
    mediaMock.getDisplayHeight.mockClear();
    mediaMock.getDisplayHeight.mockResolvedValue(720);
    mediaMock.getDisplayWidth.mockClear();
    mediaMock.getDisplayWidth.mockResolvedValue(1280);
    mediaMock.getDurationFromMetadata.mockClear();
    mediaMock.getDurationFromMetadata.mockResolvedValue(1);
    mediaMock.getFirstTimestamp.mockClear();
    mediaMock.getFirstTimestamp.mockResolvedValue(0);
    mediaMock.getFormat.mockClear();
    mediaMock.getMimeType.mockClear();
    mediaMock.getMimeType.mockResolvedValue('video/mp4; codecs="avc1.42e01e"');
    mediaMock.getPrimaryVideoTrack.mockClear();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockImplementation(async (timestamp: number) => {
      return (
        mediaMock.samples
          .slice()
          .reverse()
          .find((sample) => sample.timestamp <= timestamp) ?? null
      );
    });
    mediaMock.primaryVideoTrack = {
      getDisplayHeight: mediaMock.getDisplayHeight,
      getDisplayWidth: mediaMock.getDisplayWidth,
      getFirstTimestamp: mediaMock.getFirstTimestamp,
      type: "video",
    };
    mediaMock.getPrimaryVideoTrack.mockResolvedValue(
      mediaMock.primaryVideoTrack,
    );
    mediaMock.getTracks.mockClear();
    mediaMock.getVideoTracks.mockClear();
    mediaMock.inputConstructor.mockClear();
    mediaMock.iteratorReturn.mockClear();
    mediaMock.samples = [createMockSample(0), createMockSample(0.04)];
    mediaMock.samplesCallStarts.length = 0;
    mediaMock.tracks = [{ type: "video" }, { type: "audio" }];
    mediaMock.urlSourceConstructor.mockClear();
    mediaMock.videoSampleSinkConstructor.mockClear();
    mediaMock.videoTracks = [{ type: "video" }];
    domMock.appendChild.mockClear();
    domMock.cancelAnimationFrame.mockClear();
    domMock.createElement.mockClear();
    domMock.createElement.mockImplementation((tagName: string) => {
      if (tagName !== "canvas") {
        throw new Error(`Unexpected element: ${tagName}`);
      }

      return {
        getContext: domMock.getContext,
        height: 0,
        width: 0,
      };
    });
    domMock.getContext.mockClear();
    domMock.getContext.mockReturnValue({});
    domMock.performanceNow.mockClear();
    domMock.performanceNow.mockReturnValue(0);
    domMock.rafCallbacks.length = 0;
    domMock.requestAnimationFrame.mockClear();
  }

  function createContainer() {
    return {
      appendChild: domMock.appendChild,
      clientHeight: 360,
      clientWidth: 640,
    } as unknown as HTMLElement;
  }

  async function createProof(autoPlay = false, loop = true) {
    const { createMediaRendererProof } = await import("./index");

    return createMediaRendererProof({
      autoPlay,
      container: createContainer(),
      loop,
      src: "sample.mp4",
    });
  }

  function flushAnimationFrame(now: number) {
    const callback = domMock.rafCallbacks.shift();

    if (!callback) {
      throw new Error("No animation frame callback queued.");
    }

    domMock.performanceNow.mockReturnValue(now);
    callback(now);
  }

  it("exposes only the experimental media renderer proof", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "createMediaRendererProof",
    ]);
    expect(entrypoint.createMediaRendererProof).toEqual(expect.any(Function));
  });

  it("uses Mediabunny and does not create a video element", async () => {
    resetMocks();

    const proof = await createProof(false, false);

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

    proof.destroy();
  });

  it("draws the first decoded sample during create without starting playback", async () => {
    resetMocks();

    const proof = await createProof(false, false);

    expect(mediaMock.samplesCallStarts).toEqual([0]);
    expect(mediaMock.iteratorReturn).toHaveBeenCalledOnce();
    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samples[0].draw).toHaveBeenCalledOnce();
    expect(mediaMock.samples[0].close).toHaveBeenCalledOnce();
    expect(pixiMock.canvasSourceUpdate).toHaveBeenCalledOnce();
    expect(domMock.requestAnimationFrame).not.toHaveBeenCalled();
    expect(proof.getState()).toMatchObject({
      currentTime: 0,
      mediaHeight: 720,
      mediaWidth: 1280,
      playbackState: "ready",
      presentedFrames: 1,
    });

    proof.destroy();
  });

  it("play requests a later media timestamp and draws that sample", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];

    const proof = await createProof(false, false);
    mediaMock.getSample.mockClear();
    await proof.play();
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
    expect(proof.getState()).toMatchObject({
      currentTime: 0.04,
      presentedFrames: 2,
    });
    expect(proof.getState().playbackState).toBe("playing");

    proof.destroy();
  });

  it("closes duplicate samples without counting them as presented", async () => {
    resetMocks();

    const proof = await createProof(false, false);
    mediaMock.getSample.mockResolvedValueOnce(mediaMock.samples[0]);
    await proof.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].close).toHaveBeenCalledTimes(2);
    });

    expect(proof.getState()).toMatchObject({
      currentTime: 0,
      presentedFrames: 1,
    });
    expect(mediaMock.samples[0].draw).toHaveBeenCalledOnce();
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();

    proof.destroy();
  });

  it("does not overlap decode requests while getSample is in flight", async () => {
    resetMocks();

    const proof = await createProof(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await proof.play();
    flushAnimationFrame(40);

    expect(mediaMock.getSample).toHaveBeenCalledOnce();
    expect(domMock.rafCallbacks).toHaveLength(0);

    deferred.resolve(mediaMock.samples[1]);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
      expect(domMock.rafCallbacks).toHaveLength(1);
    });

    proof.destroy();
  });

  it("pause prevents late async samples from drawing", async () => {
    resetMocks();

    const proof = await createProof(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await proof.play();
    flushAnimationFrame(40);
    proof.pause();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(proof.getState().playbackState).toBe("paused");

    proof.destroy();
  });

  it("destroy prevents late async samples from drawing", async () => {
    resetMocks();

    const proof = await createProof(false, false);
    const deferred = createDeferred<MockVideoSample | null>();
    mediaMock.getSample.mockClear();
    mediaMock.getSample.mockReturnValueOnce(deferred.promise);

    await proof.play();
    flushAnimationFrame(40);
    proof.destroy();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(proof.getState().playbackState).toBe("destroyed");
  });

  it("cleans up scheduled frames, media input, and Pixi on destroy", async () => {
    resetMocks();

    const proof = await createProof(false);
    await proof.play();
    proof.destroy();

    expect(domMock.cancelAnimationFrame).toHaveBeenCalled();
    expect(mediaMock.dispose).toHaveBeenCalledOnce();
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(proof.getState().playbackState).toBe("destroyed");
  });

  it("puts the proof in error state when Mediabunny decode setup fails", async () => {
    resetMocks();
    mediaMock.getPrimaryVideoTrack.mockRejectedValue(
      new Error("decode failed"),
    );

    const proof = await createProof(false);

    expect(proof.getState().playbackState).toBe("error");
    expect(proof.getState().demux).toMatchObject({
      errorMessage: "decode failed",
      status: "error",
    });
    expect(pixiMock.stageAddChild).not.toHaveBeenCalled();

    proof.destroy();
  });
});
