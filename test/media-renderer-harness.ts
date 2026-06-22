import { vi } from "vitest";

export type MockVideoSample = {
  close: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  duration: number;
  timestamp: number;
};

export function createMockSample(
  timestamp: number,
  duration = 0.04,
): MockVideoSample {
  return {
    close: vi.fn(),
    draw: vi.fn(),
    duration,
    timestamp,
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}

type MockSamplesIterator = AsyncGenerator<MockVideoSample, void, unknown>;
type MockSamplesImplementation = (
  startTimestamp?: number,
  endTimestamp?: number,
  options?: unknown,
) => MockSamplesIterator;

const mockState = vi.hoisted(() => {
  const pixiMock = {
    appDestroy: vi.fn(),
    appInit: vi.fn(async () => undefined),
    canvasSourceOptions: [] as unknown[],
    canvasSourceUpdate: vi.fn(),
    containerAddChild: vi.fn(),
    containerInstances: [] as Array<{
      children: unknown[];
      cursor?: string;
      eventMode?: string;
      hitArea?: unknown;
      position: { set: ReturnType<typeof vi.fn> };
      scale: { set: ReturnType<typeof vi.fn> };
      on: ReturnType<typeof vi.fn>;
    }>,
    graphicsInstances: [] as Array<{
      clear: ReturnType<typeof vi.fn>;
      fill: ReturnType<typeof vi.fn>;
      rect: ReturnType<typeof vi.fn>;
      roundRect: ReturnType<typeof vi.fn>;
      stroke: ReturnType<typeof vi.fn>;
      visible: boolean;
      x: number;
      y: number;
    }>,
    imageSourceDestroy: vi.fn(),
    imageSourceOptions: [] as unknown[],
    meshGeometryDestroy: vi.fn(),
    meshGeometryOptions: [] as unknown[],
    meshInstances: [] as Array<{
      destroy: ReturnType<typeof vi.fn>;
      visible: boolean;
    }>,
    shaderDestroy: vi.fn(),
    shaderFrom: vi.fn(),
    shaderInstances: [] as Array<{
      destroy: ReturnType<typeof vi.fn>;
      resources: Record<string, unknown>;
    }>,
    rendererResize: vi.fn(),
    stageAddChild: vi.fn(),
    spriteInstances: [] as Array<{
      height: number;
      options: unknown;
      texture: unknown;
      visible: boolean;
      width: number;
    }>,
    tickerAdd: vi.fn(),
    tickerRemove: vi.fn(),
    textureDestroy: vi.fn(),
    textureOptions: [] as unknown[],
    textureUpdate: vi.fn(),
    textInstances: [] as Array<{
      alpha: number;
      destroy: ReturnType<typeof vi.fn>;
      height: number;
      style: unknown;
      text: string;
      visible: boolean;
      width: number;
      x: number;
      y: number;
    }>,
    uniformGroupInstances: [] as Array<{
      uniforms: Record<string, unknown>;
      update: ReturnType<typeof vi.fn>;
    }>,
  };
  const mediaMock = {
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
    sampleNextCalls: [] as number[],
    samples: [] as MockVideoSample[],
    samplesCallEnds: [] as Array<number | undefined>,
    samplesCallOptions: [] as unknown[],
    samplesCallStarts: [] as Array<number | undefined>,
    samplesImplementation: undefined as MockSamplesImplementation | undefined,
    tracks: [{ type: "video" }, { type: "audio" }],
    urlSourceConstructor: vi.fn(),
    videoSampleSinkConstructor: vi.fn(),
    videoTracks: [{ type: "video" }],
  };
  const domMock = {
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
  };

  return { domMock, mediaMock, pixiMock };
});

export const pixiMock = mockState.pixiMock;
export const mediaMock = mockState.mediaMock;
export const domMock = mockState.domMock;

vi.mock("pixi.js", () => {
  class Application {
    canvas = { style: {} };
    renderer = { name: "webgl", resize: pixiMock.rendererResize };
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

  class ImageSource {
    destroy = pixiMock.imageSourceDestroy;
    style = {};

    constructor(options: unknown) {
      pixiMock.imageSourceOptions.push(options);
    }
  }

  class Texture {
    static EMPTY = { source: { style: {} } };

    readonly id = pixiMock.textureOptions.length;
    readonly source: unknown;

    constructor(options: { source?: unknown }) {
      this.source = options.source;
      pixiMock.textureOptions.push(options);
    }

    destroy = pixiMock.textureDestroy;
    update = pixiMock.textureUpdate;
  }

  class Container {
    children: unknown[] = [];
    cursor?: string;
    eventMode?: string;
    hitArea?: unknown;
    on = vi.fn();
    position = { set: vi.fn() };
    scale = { set: vi.fn() };

    constructor() {
      pixiMock.containerInstances.push(this);
    }

    addChild(...children: unknown[]) {
      for (const child of children) {
        const existingIndex = this.children.indexOf(child);

        if (existingIndex >= 0) {
          this.children.splice(existingIndex, 1);
        }
      }

      this.children.push(...children);
      pixiMock.containerAddChild(...children);
      return children[0];
    }

    removeChild(...children: unknown[]) {
      for (const child of children) {
        const index = this.children.indexOf(child);

        if (index >= 0) {
          this.children.splice(index, 1);
        }
      }

      return children[0];
    }
  }

  class Graphics {
    clear = vi.fn(() => this);
    fill = vi.fn(() => this);
    rect = vi.fn(() => this);
    roundRect = vi.fn(() => this);
    stroke = vi.fn(() => this);
    visible = true;
    x = 0;
    y = 0;

    constructor() {
      pixiMock.graphicsInstances.push(this);
    }
  }

  class Rectangle {
    constructor(
      public readonly x: number,
      public readonly y: number,
      public readonly width: number,
      public readonly height: number,
    ) {}

    contains(x: number, y: number) {
      return (
        x >= this.x &&
        x <= this.x + this.width &&
        y >= this.y &&
        y <= this.y + this.height
      );
    }
  }

  class Sprite {
    anchor = { set: vi.fn() };
    height = 0;
    position = { set: vi.fn() };
    texture: unknown;
    visible = true;
    width = 0;

    constructor(public readonly options: { texture?: unknown } = {}) {
      this.texture = options.texture;
      pixiMock.spriteInstances.push(this);
    }
  }

  class Mesh {
    destroy = vi.fn();
    visible = true;

    constructor(public readonly options: unknown) {
      pixiMock.meshInstances.push(this);
    }
  }

  class MeshGeometry {
    destroy = pixiMock.meshGeometryDestroy;

    constructor(options: unknown) {
      pixiMock.meshGeometryOptions.push(options);
    }
  }

  class Shader {
    resources: Record<string, unknown>;
    destroy = pixiMock.shaderDestroy;

    constructor(options: { resources?: Record<string, unknown> } = {}) {
      this.resources = options.resources ?? {};
      pixiMock.shaderInstances.push(this);
    }

    static from(options: { resources?: Record<string, unknown> }) {
      pixiMock.shaderFrom(options);
      return new Shader(options);
    }
  }

  class UniformGroup {
    uniforms: Record<string, unknown> = {};
    update = vi.fn();

    constructor(uniforms: Record<string, unknown>) {
      for (const [key, value] of Object.entries(uniforms)) {
        this.uniforms[key] =
          isRecord(value) && "value" in value ? value.value : value;
      }

      pixiMock.uniformGroupInstances.push(this);
    }
  }

  class Text {
    alpha = 1;
    destroy = vi.fn();
    height = 16;
    style: unknown;
    visible = true;
    width = 0;
    x = 0;
    y = 0;

    constructor(options: { text?: string; style?: unknown } = {}) {
      this.text = options.text ?? "";
      this.style = options.style;
      pixiMock.textInstances.push(this);
    }

    private value = "";

    get text() {
      return this.value;
    }

    set text(value: string) {
      this.value = value;
      this.width = value.length * 8;
    }
  }

  return {
    Application,
    CanvasSource,
    Container,
    Graphics,
    ImageSource,
    Mesh,
    MeshGeometry,
    Rectangle,
    Sprite,
    Shader,
    Text,
    Texture,
    UniformGroup,
  };
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

    samples(startTimestamp?: number, endTimestamp?: number, options?: unknown) {
      mediaMock.samplesCallStarts.push(startTimestamp);
      mediaMock.samplesCallEnds.push(endTimestamp);
      mediaMock.samplesCallOptions.push(options);

      if (mediaMock.samplesImplementation) {
        return mediaMock.samplesImplementation(
          startTimestamp,
          endTimestamp,
          options,
        );
      }

      let index = mediaMock.samples.findIndex(
        (sample) =>
          startTimestamp === undefined || sample.timestamp >= startTimestamp,
      );

      if (index < 0) {
        index = mediaMock.samples.length;
      }

      return {
        async next() {
          mediaMock.sampleNextCalls.push(index);

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

vi.stubGlobal(
  "ImageData",
  class ImageData {
    constructor(
      public readonly data: Uint8ClampedArray,
      public readonly width: number,
      public readonly height: number,
    ) {}
  },
);

export function resetMocks() {
  pixiMock.appDestroy.mockClear();
  pixiMock.appInit.mockClear();
  pixiMock.appInit.mockResolvedValue(undefined);
  pixiMock.canvasSourceOptions.length = 0;
  pixiMock.canvasSourceUpdate.mockClear();
  pixiMock.containerAddChild.mockClear();
  pixiMock.containerInstances.length = 0;
  pixiMock.graphicsInstances.length = 0;
  pixiMock.imageSourceDestroy.mockClear();
  pixiMock.imageSourceOptions.length = 0;
  pixiMock.meshGeometryDestroy.mockClear();
  pixiMock.meshGeometryOptions.length = 0;
  pixiMock.meshInstances.length = 0;
  pixiMock.shaderDestroy.mockClear();
  pixiMock.shaderFrom.mockClear();
  pixiMock.shaderInstances.length = 0;
  pixiMock.rendererResize.mockClear();
  pixiMock.stageAddChild.mockClear();
  pixiMock.spriteInstances.length = 0;
  pixiMock.tickerAdd.mockClear();
  pixiMock.tickerRemove.mockClear();
  pixiMock.textureDestroy.mockClear();
  pixiMock.textureOptions.length = 0;
  pixiMock.textureUpdate.mockClear();
  pixiMock.textInstances.length = 0;
  pixiMock.uniformGroupInstances.length = 0;
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
  mediaMock.getPrimaryVideoTrack.mockResolvedValue(mediaMock.primaryVideoTrack);
  mediaMock.getTracks.mockClear();
  mediaMock.getVideoTracks.mockClear();
  mediaMock.inputConstructor.mockClear();
  mediaMock.iteratorReturn.mockClear();
  mediaMock.sampleNextCalls.length = 0;
  mediaMock.samples = [createMockSample(0), createMockSample(0.04)];
  mediaMock.samplesCallEnds.length = 0;
  mediaMock.samplesCallOptions.length = 0;
  mediaMock.samplesCallStarts.length = 0;
  mediaMock.samplesImplementation = undefined;
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
  domMock.getContext.mockReturnValue({
    drawImage: vi.fn(),
    putImageData: vi.fn(),
  });
  domMock.performanceNow.mockClear();
  domMock.performanceNow.mockReturnValue(0);
  domMock.rafCallbacks.length = 0;
  domMock.requestAnimationFrame.mockClear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createContainer() {
  return {
    appendChild: domMock.appendChild,
    clientHeight: 360,
    clientWidth: 640,
  } as unknown as HTMLElement;
}

export async function createRenderer(
  autoPlay = false,
  loop = true,
  overrides: Record<string, unknown> = {},
) {
  const { createMediaRenderer } = await import("../src/index");

  return createMediaRenderer({
    autoPlay,
    container: createContainer(),
    loop,
    src: "sample.mp4",
    ...overrides,
  });
}

export function flushAnimationFrame(now: number) {
  const callback = domMock.rafCallbacks.shift();

  if (!callback) {
    throw new Error("No animation frame callback queued.");
  }

  domMock.performanceNow.mockReturnValue(now);
  callback(now);
}
