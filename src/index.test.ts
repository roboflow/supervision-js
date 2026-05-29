import { beforeAll, describe, expect, it, vi } from "vitest";

import type { BoxStyle } from "#types/box-style";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { Detection } from "#types/detections";
import type { MaskStyle } from "#types/mask-style";

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

let BaseBoxStyle: PackageEntrypoint["BaseBoxStyle"];
let BaseMaskStyle: PackageEntrypoint["BaseMaskStyle"];
let DetectionBufferStatus: PackageEntrypoint["DetectionBufferStatus"];
let DetectionFrameSelectionMode: PackageEntrypoint["DetectionFrameSelectionMode"];
let DetectionMaskEncoding: PackageEntrypoint["DetectionMaskEncoding"];
let RoundedBoxStyle: PackageEntrypoint["RoundedBoxStyle"];
let MediaRendererPlaybackState: PackageEntrypoint["MediaRendererPlaybackState"];
let MediaSourceStatus: PackageEntrypoint["MediaSourceStatus"];

describe("package entrypoint", () => {
  beforeAll(async () => {
    const entrypoint = await import("./index");

    BaseBoxStyle = entrypoint.BaseBoxStyle;
    BaseMaskStyle = entrypoint.BaseMaskStyle;
    DetectionBufferStatus = entrypoint.DetectionBufferStatus;
    DetectionFrameSelectionMode = entrypoint.DetectionFrameSelectionMode;
    DetectionMaskEncoding = entrypoint.DetectionMaskEncoding;
    RoundedBoxStyle = entrypoint.RoundedBoxStyle;
    MediaRendererPlaybackState = entrypoint.MediaRendererPlaybackState;
    MediaSourceStatus = entrypoint.MediaSourceStatus;
  });

  it("exposes the media renderer and public renderer enums", async () => {
    const entrypoint = await import("./index");

    expect(Object.keys(entrypoint).sort()).toEqual([
      "BaseBoxStyle",
      "BaseMaskStyle",
      "BoxShape",
      "DetectionBufferStatus",
      "DetectionFrameSelectionMode",
      "DetectionMaskEncoding",
      "MediaNormalizationAudioCodec",
      "MediaNormalizationContainer",
      "MediaNormalizationFit",
      "MediaNormalizationVideoCodec",
      "MediaPreparationError",
      "MediaProbeIssueCode",
      "MediaProbeStatus",
      "MediaRendererFit",
      "MediaRendererPlaybackState",
      "MediaSourceStatus",
      "RoundedBoxStyle",
      "createArrayDetectionFrameSource",
      "createBrowserColdDetectionFrameStore",
      "createBufferedDetectionTimeline",
      "createChunkedDetectionFrameSource",
      "createColdDetectionFrameSource",
      "createMediaRenderer",
      "createWritableDetectionFrameSource",
      "normalizeMedia",
      "normalizeMediaProgressively",
      "prepareMedia",
      "probeMedia",
    ]);
    expect(entrypoint.createMediaRenderer).toEqual(expect.any(Function));
    expect(entrypoint.createWritableDetectionFrameSource).toEqual(
      expect.any(Function),
    );
    expect(entrypoint.normalizeMedia).toEqual(expect.any(Function));
    expect(entrypoint.normalizeMediaProgressively).toEqual(
      expect.any(Function),
    );
    expect(entrypoint.prepareMedia).toEqual(expect.any(Function));
    expect(entrypoint.MediaPreparationError).toEqual(expect.any(Function));
    expect(entrypoint.probeMedia).toEqual(expect.any(Function));
    expect(entrypoint.BaseBoxStyle).toEqual(expect.any(Function));
    expect(entrypoint.BaseMaskStyle).toEqual(expect.any(Function));
    expect(entrypoint.RoundedBoxStyle).toEqual(expect.any(Function));
    expect(entrypoint.BoxShape).toEqual({
      Rect: "rect",
      RoundedRect: "roundedRect",
    });
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
    expect(entrypoint.DetectionBufferStatus).toEqual({
      Destroyed: "destroyed",
      Error: "error",
      Idle: "idle",
      Loading: "loading",
      Ready: "ready",
    });
    expect(DetectionFrameSelectionMode).toEqual({
      Interval: "interval",
      NearestFrameIndex: "nearestFrameIndex",
    });
    expect(entrypoint.DetectionMaskEncoding).toEqual({
      CompressedRle: "compressedRle",
    });
    expect(entrypoint.MediaNormalizationContainer).toEqual({
      Mp4: "mp4",
      WebM: "webm",
    });
    expect(entrypoint.MediaNormalizationVideoCodec).toEqual({
      Av1: "av1",
      Avc: "avc",
      Vp8: "vp8",
      Vp9: "vp9",
    });
    expect(entrypoint.MediaNormalizationAudioCodec).toEqual({
      Aac: "aac",
      Opus: "opus",
    });
    expect(entrypoint.MediaNormalizationFit).toEqual({
      Contain: "contain",
      Cover: "cover",
      Fill: "fill",
    });
    expect(entrypoint.MediaProbeStatus).toEqual({
      Supported: "supported",
      Unsupported: "unsupported",
    });
    expect(entrypoint.MediaProbeIssueCode).toEqual({
      InputCannotRead: "inputCannotRead",
      PrimaryVideoCannotDecode: "primaryVideoCannotDecode",
      PrimaryVideoMissing: "primaryVideoMissing",
      TargetVideoCannotEncode: "targetVideoCannotEncode",
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

  it("resolves BaseMaskStyle defaults only for detections with masks", () => {
    const style = new BaseMaskStyle();
    const mask = {
      counts: "021",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 2,
      width: 2,
    };

    expect(style.resolve({ mask })).toEqual({
      alpha: 0.35,
      color: 0x00ff66,
      mask,
    });
    expect(style.resolve({})).toBeUndefined();
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
      detectionBuffer: {
        bufferEndTime: 5,
        bufferStartTime: 0,
        detectionCount: 0,
        frameCount: 0,
        status: DetectionBufferStatus.Ready,
      },
      mediaHeight: 720,
      mediaWidth: 1280,
      playbackState: MediaRendererPlaybackState.Ready,
      presentedFrames: 1,
    });

    renderer.destroy();
  });

  it("play reads sequential samples and draws the due sample", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];

    const renderer = await createRenderer(false, false);
    mediaMock.getSample.mockClear();
    mediaMock.samplesCallStarts.length = 0;
    mediaMock.samplesCallEnds.length = 0;
    mediaMock.samplesCallOptions.length = 0;
    await renderer.play();
    await vi.waitFor(() => {
      expect(domMock.requestAnimationFrame).toHaveBeenCalledOnce();
      expect(mediaMock.samplesCallStarts).toEqual([0]);
    });

    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samplesCallStarts).toEqual([0]);
    expect(mediaMock.samplesCallEnds).toEqual([undefined]);
    expect(mediaMock.samplesCallOptions).toEqual([{ skipLiveWait: true }]);
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.04,
      presentedFrames: 2,
    });
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Playing,
    );

    renderer.destroy();
  });

  it("seek uses random sample lookup and updates detections and buffer state", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          frameIndex: 0,
          mediaTime: 0,
        },
        {
          detections: [{ rect: { height: 40, width: 30, x: 20, y: 10 } }],
          frameIndex: 2,
          mediaTime: 0.08,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    mediaMock.getSample.mockClear();
    mediaMock.samplesCallStarts.length = 0;

    await renderer.seek(0.08);

    expect(mediaMock.getSample).toHaveBeenCalledOnce();
    expect(mediaMock.getSample).toHaveBeenLastCalledWith(0.08, {
      skipLiveWait: true,
    });
    expect(mediaMock.samplesCallStarts).toEqual([]);
    expect(mediaMock.samples[2].draw).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenLastCalledWith(20, 10, 30, 40);
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 2,
      activeDetectionFrameTime: 0.08,
      currentTime: 0.08,
      detectionBuffer: {
        bufferStartTime: 0,
        detectionCount: 2,
        frameCount: 2,
        status: DetectionBufferStatus.Ready,
      },
      presentedFrames: 2,
    });

    renderer.destroy();
  });

  it("seek preserves playing state and restarts sequential playback at the new time", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const renderer = await createRenderer(false, false);

    mediaMock.getSample.mockClear();
    mediaMock.samplesCallStarts.length = 0;
    await renderer.play();
    await vi.waitFor(() => {
      expect(mediaMock.samplesCallStarts).toEqual([0]);
    });

    await renderer.seek(0.08);

    expect(mediaMock.getSample).toHaveBeenCalledOnce();
    expect(mediaMock.samplesCallStarts).toEqual([0, 0.08]);
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.08,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    renderer.destroy();
  });

  it("closes duplicate samples without counting them as presented", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0, 0)];

    const renderer = await createRenderer(false, false);
    mediaMock.getSample.mockClear();
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].close).toHaveBeenCalledTimes(2);
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(renderer.getState()).toMatchObject({
      currentTime: 0,
      presentedFrames: 1,
    });
    expect(mediaMock.samples[0].draw).toHaveBeenCalledOnce();
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();

    renderer.destroy();
  });

  it("skips stale queued samples to catch up to the playback clock", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
      createMockSample(0.12, 0),
    ];

    const renderer = await createRenderer(false, false);
    mediaMock.getSample.mockClear();

    await renderer.play();
    await vi.waitFor(() => {
      expect(mediaMock.sampleNextCalls.length).toBeGreaterThanOrEqual(5);
    });
    flushAnimationFrame(120);
    await vi.waitFor(() => {
      expect(mediaMock.samples[3].draw).toHaveBeenCalledOnce();
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(mediaMock.samples[2].draw).not.toHaveBeenCalled();
    expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    expect(mediaMock.samples[2].close).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      currentTime: 0.12,
      presentedFrames: 2,
    });

    renderer.destroy();
  });

  it("selects detection frames from decoded sample timestamps", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const onFrame = vi.fn();
    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        stroke: {
          alpha: 0.5,
          color: 0x38bdf8,
          width: 4,
        },
      }),
      detectionFrames: [
        {
          detections: [
            {
              rect: {
                height: 40,
                width: 30,
                x: 20,
                y: 10,
              },
            },
          ],
          mediaTime: 0.07,
        },
        {
          detections: [
            {
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0.04,
        },
      ],
      onFrame,
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.rect).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeDetectionCount: 0,
        activeDetectionFrameTime: null,
        detectionBuffer: expect.objectContaining({
          detectionCount: 2,
          frameCount: 2,
          status: DetectionBufferStatus.Ready,
        }),
        mediaTime: 0,
      }),
    );

    mediaMock.getSample.mockClear();
    mediaMock.samplesCallStarts.length = 0;
    await renderer.play();
    flushAnimationFrame(70);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samplesCallStarts).toEqual([0]);
    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenLastCalledWith(4, 5, 10, 20);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x38bdf8,
      width: 4,
    });
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0.04,
      detectionBuffer: {
        bufferEndTime: 5,
        bufferStartTime: 0,
        detectionCount: 2,
        errorMessage: null,
        frameCount: 2,
        requestedEndTime: 5,
        requestedStartTime: 0,
        status: DetectionBufferStatus.Ready,
      },
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[2].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.rect).toHaveBeenLastCalledWith(20, 10, 30, 40);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x38bdf8,
      width: 4,
    });
    expect(onFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeDetectionCount: 1,
        activeDetectionFrameTime: 0.07,
        detectionBuffer: expect.objectContaining({
          detectionCount: 2,
          frameCount: 2,
          status: DetectionBufferStatus.Ready,
        }),
        mediaTime: 0.08,
      }),
    );

    renderer.destroy();
  });

  it("draws BaseBoxStyle defaults and skips detections without rects", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [
            { className: "missing-rect" },
            {
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.clear).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenLastCalledWith(4, 5, 10, 20);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 1,
      color: 0x00ff66,
      width: 2,
    });
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 2,
      activeDetectionFrameTime: 0,
    });

    renderer.destroy();
  });

  it("draws RoundedBoxStyle boxes with fill and stroke", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      boxStyle: new RoundedBoxStyle({
        cornerRadius: 8,
        fill: {
          alpha: 0.25,
          color: 0x112233,
        },
        stroke: {
          alpha: 0.75,
          color: 0xabcdef,
          width: 3,
        },
      }),
      detectionFrames: [
        {
          detections: [
            {
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.roundRect).toHaveBeenCalledOnce();
    expect(boxGraphics.roundRect).toHaveBeenLastCalledWith(4, 5, 10, 20, 8);
    expect(boxGraphics.fill).toHaveBeenLastCalledWith({
      alpha: 0.25,
      color: 0x112233,
    });
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.75,
      color: 0xabcdef,
      width: 3,
    });

    renderer.destroy();
  });

  it("does not create mask textures unless a mask style is supplied", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [
            {
              mask: {
                counts: "021",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 2,
                width: 2,
              },
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0,
        },
      ],
    });

    expect(pixiMock.canvasSourceOptions).toHaveLength(1);
    expect(pixiMock.textureOptions).toHaveLength(1);
    expect(pixiMock.spriteInstances).toHaveLength(1);

    renderer.destroy();
  });

  it("cancels scheduled mask preparation when destroyed before it runs", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const renderer = await createRenderer(false, false, {
        detectionFrames: [
          {
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
            mediaTime: 0,
          },
        ],
        maskStyle: new BaseMaskStyle(),
      });

      expect(pixiMock.canvasSourceOptions).toHaveLength(1);
      expect(pixiMock.textureOptions).toHaveLength(1);

      renderer.destroy();
      await vi.runAllTimersAsync();

      expect(pixiMock.canvasSourceOptions).toHaveLength(1);
      expect(pixiMock.textureOptions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prepares a composited mask texture without breaking box drawing", async () => {
    resetMocks();

    const resolve = vi.fn((detection: Detection) =>
      detection.mask
        ? {
            alpha: 0.5,
            color: 0xff0000,
            mask: detection.mask,
          }
        : undefined,
    );
    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        stroke: {
          alpha: 0.5,
          color: 0x38bdf8,
          width: 4,
        },
      }),
      detectionFrames: [
        {
          detections: [
            {
              mask: {
                counts: "021",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 2,
                width: 2,
              },
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0,
        },
      ],
      maskStyle: { resolve },
    });
    const scene = pixiMock.containerInstances[0];
    const boxGraphics = pixiMock.graphicsInstances[0];

    await vi.waitFor(() => {
      expect(pixiMock.canvasSourceOptions).toHaveLength(2);
      expect(pixiMock.textureOptions).toHaveLength(2);
    });

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ mask: expect.any(Object) }),
      expect.objectContaining({
        detectionIndex: 0,
        mediaTime: 0,
      }),
    );
    expect(scene?.children).toEqual([
      pixiMock.spriteInstances[0],
      pixiMock.spriteInstances[1],
      boxGraphics,
    ]);
    expect(pixiMock.spriteInstances[1]).toMatchObject({
      height: 720,
      texture: expect.any(Object),
      visible: true,
      width: 1280,
    });
    expect(boxGraphics.rect).toHaveBeenLastCalledWith(4, 5, 10, 20);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x38bdf8,
      width: 4,
    });

    renderer.destroy();

    expect(pixiMock.textureDestroy).toHaveBeenCalledWith(true);
  });

  it("does not rescan the mask warm window for every active frame change", async () => {
    resetMocks();

    const { createPixiMaskLayer } = await import("./renderers/pixi-mask-layer");
    const { CanvasSource, Sprite, Texture } = await import("pixi.js");
    const detectionFrames = [
      {
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
        mediaTime: 0,
      },
      {
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
        mediaTime: 0.04,
      },
      {
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
        mediaTime: 0.08,
      },
    ];
    const detectionTimeline = {
      destroy: vi.fn(),
      getBufferedFrames: vi.fn(() => detectionFrames),
      getState: vi.fn(() => ({
        bufferEndTime: 5,
        bufferStartTime: 0,
        detectionCount: 3,
        errorMessage: null,
        frameCount: 3,
        requestedEndTime: 5,
        requestedStartTime: 0,
        status: DetectionBufferStatus.Ready,
      })),
      prepare: vi.fn(),
      prefetch: vi.fn(),
      selectFrame: vi.fn((mediaTime: number) =>
        detectionFrames.find((frame) => frame.mediaTime === mediaTime),
      ),
    } satisfies BufferedDetectionTimeline;

    const layer = createPixiMaskLayer({
      CanvasSource,
      detectionTimeline,
      maskStyle: new BaseMaskStyle(),
      Sprite,
      Texture,
    });

    layer.createSprite({ height: 720, width: 1280 });
    layer.drawFrame(0);
    layer.drawFrame(0.04);
    layer.drawFrame(0.08);

    expect(detectionTimeline.getBufferedFrames).toHaveBeenCalledOnce();

    layer.destroy();
  });

  it("defaults partial box fill values", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        fill: {},
      }),
      detectionFrames: [
        {
          detections: [
            {
              rect: {
                height: 20,
                width: 10,
                x: 4,
                y: 5,
              },
            },
          ],
          mediaTime: 0,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.fill).toHaveBeenLastCalledWith({
      alpha: 1,
      color: 0x00ff66,
    });

    renderer.destroy();
  });

  it("passes detection indexes to box styles", async () => {
    resetMocks();

    const resolve = vi.fn<BoxStyle["resolve"]>(() => undefined);
    const detectionFrame = {
      detections: [
        { rect: { height: 20, width: 10, x: 4, y: 5 } },
        { rect: { height: 40, width: 30, x: 20, y: 10 } },
      ],
      mediaTime: 0,
    };

    const renderer = await createRenderer(false, false, {
      boxStyle: { resolve },
      detectionFrames: [detectionFrame],
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0]?.[1]).toMatchObject({
      detectionIndex: 0,
      frame: {
        detections: expect.arrayContaining([
          expect.objectContaining(detectionFrame.detections[0]),
          expect.objectContaining(detectionFrame.detections[1]),
        ]),
        mediaTime: 0,
      },
      mediaTime: 0,
    });
    expect(resolve.mock.calls[1]?.[1]).toMatchObject({
      detectionIndex: 1,
      frame: {
        detections: expect.arrayContaining([
          expect.objectContaining(detectionFrame.detections[0]),
          expect.objectContaining(detectionFrame.detections[1]),
        ]),
        mediaTime: 0,
      },
      mediaTime: 0,
    });

    renderer.destroy();
  });

  it("presents the first sample and first detection frame again at a loop boundary", async () => {
    resetMocks();
    mediaMock.getDurationFromMetadata.mockResolvedValue(0.08);
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];

    const renderer = await createRenderer(false, true, {
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          mediaTime: 0,
        },
        {
          detections: [{ rect: { height: 40, width: 30, x: 20, y: 10 } }],
          mediaTime: 0.04,
        },
      ],
    });

    mediaMock.getSample.mockClear();
    mediaMock.samplesCallStarts.length = 0;
    mediaMock.samplesCallOptions.length = 0;
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0.04,
      currentTime: 0.04,
      presentedFrames: 2,
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].draw).toHaveBeenCalledTimes(2);
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samplesCallStarts).toEqual([0, 0]);
    expect(mediaMock.samplesCallOptions).toEqual([
      { skipLiveWait: true },
      { skipLiveWait: true },
    ]);
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0,
      presentedFrames: 3,
    });

    renderer.destroy();
  });

  it("does not redraw boxes or update detection diagnostics for duplicate samples", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0, 0)];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          mediaTime: 0,
        },
        {
          detections: [{ rect: { height: 40, width: 30, x: 20, y: 10 } }],
          mediaTime: 0.04,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];
    const initialBoxRectCalls = boxGraphics.rect.mock.calls.length;
    const initialBoxClearCalls = boxGraphics.clear.mock.calls.length;

    mediaMock.getSample.mockClear();
    await renderer.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[0].close).toHaveBeenCalledTimes(2);
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(boxGraphics.rect).toHaveBeenCalledTimes(initialBoxRectCalls);
    expect(boxGraphics.clear).toHaveBeenCalledTimes(initialBoxClearCalls);
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0,
      presentedFrames: 1,
    });

    renderer.destroy();
  });

  it("does not redraw boxes when presented samples stay within the same active detection frame", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.02, 0),
      createMockSample(0.04, 0),
      createMockSample(0.08, 0),
    ];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          mediaTime: 0,
        },
        {
          detections: [{ rect: { height: 40, width: 30, x: 20, y: 10 } }],
          mediaTime: 0.08,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.clear).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.stroke).toHaveBeenCalledOnce();

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.clear).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0.02,
      presentedFrames: 2,
    });

    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[2].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.clear).toHaveBeenCalledOnce();
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0.04,
      presentedFrames: 3,
    });

    flushAnimationFrame(80);
    await vi.waitFor(() => {
      expect(mediaMock.samples[3].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenCalledTimes(2);
    expect(boxGraphics.stroke).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenLastCalledWith(20, 10, 30, 40);
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0.08,
      currentTime: 0.08,
      presentedFrames: 4,
    });

    renderer.destroy();
  });

  it("updates box style at runtime and redraws the same active detection frame", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.02, 0)];

    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        stroke: {
          alpha: 0.5,
          color: 0x38bdf8,
          width: 4,
        },
      }),
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          mediaTime: 0,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.5,
      color: 0x38bdf8,
      width: 4,
    });

    renderer.setPresentation({
      boxStyle: new BaseBoxStyle({
        stroke: {
          alpha: 0.8,
          color: 0xff00ff,
          width: 7,
        },
      }),
    });

    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenCalledTimes(2);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.8,
      color: 0xff00ff,
      width: 7,
    });
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0,
      presentedFrames: 1,
    });

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenCalledTimes(2);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.8,
      color: 0xff00ff,
      width: 7,
    });
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0.02,
      presentedFrames: 2,
    });

    renderer.destroy();
  });

  it("disables boxes at runtime and keeps detection diagnostics intact", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.02, 0)];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
          detections: [{ rect: { height: 20, width: 10, x: 4, y: 5 } }],
          mediaTime: 0,
        },
      ],
    });
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.rect).toHaveBeenCalledOnce();

    renderer.setPresentation({ boxStyle: null });

    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0,
      presentedFrames: 1,
    });

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(boxGraphics.clear).toHaveBeenCalledTimes(2);
    expect(boxGraphics.rect).toHaveBeenCalledOnce();
    expect(boxGraphics.stroke).toHaveBeenCalledOnce();
    expect(renderer.getState()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
      currentTime: 0.02,
      presentedFrames: 2,
    });

    renderer.destroy();
  });

  it("updates mask style at runtime and invalidates cached mask textures", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.02, 0)];

    const firstResolve = vi.fn<MaskStyle["resolve"]>((detection) =>
      detection.mask
        ? {
            alpha: 0.25,
            color: 0xff0000,
            mask: detection.mask,
          }
        : undefined,
    );
    const secondResolve = vi.fn<MaskStyle["resolve"]>((detection) =>
      detection.mask
        ? {
            alpha: 0.75,
            color: 0x0000ff,
            mask: detection.mask,
          }
        : undefined,
    );
    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
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
          mediaTime: 0,
        },
      ],
      maskStyle: { resolve: firstResolve },
    });

    await vi.waitFor(() => {
      expect(pixiMock.textureOptions).toHaveLength(2);
    });

    renderer.setPresentation({ maskStyle: { resolve: secondResolve } });

    expect(pixiMock.textureDestroy).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(pixiMock.textureOptions).toHaveLength(3);
    });
    expect(secondResolve).toHaveBeenCalledWith(
      expect.objectContaining({ mask: expect.any(Object) }),
      expect.objectContaining({
        detectionIndex: 0,
        mediaTime: 0,
      }),
    );

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
      expect(pixiMock.textureOptions).toHaveLength(3);
    });

    expect(firstResolve).toHaveBeenCalled();
    expect(pixiMock.spriteInstances[1]).toMatchObject({
      height: 720,
      texture: expect.any(Object),
      visible: true,
      width: 1280,
    });

    renderer.destroy();
  });

  it("disables masks at runtime and clears cached mask textures", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.02, 0)];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
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
          mediaTime: 0,
        },
      ],
      maskStyle: new BaseMaskStyle(),
    });

    await vi.waitFor(() => {
      expect(pixiMock.textureOptions).toHaveLength(2);
      expect(pixiMock.spriteInstances[1]?.visible).toBe(true);
    });

    renderer.setPresentation({ maskStyle: null });

    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(pixiMock.textureDestroy).toHaveBeenCalledWith(true);
    expect(pixiMock.textureOptions).toHaveLength(2);
    expect(pixiMock.spriteInstances[1]).toMatchObject({
      visible: false,
    });

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(pixiMock.textureDestroy).toHaveBeenCalledWith(true);
    expect(pixiMock.textureOptions).toHaveLength(2);
    expect(pixiMock.spriteInstances[1]).toMatchObject({
      visible: false,
    });

    renderer.destroy();
  });

  it("enables masks at runtime without recreating the Pixi scene", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.02, 0)];

    const renderer = await createRenderer(false, false, {
      detectionFrames: [
        {
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
          mediaTime: 0,
        },
      ],
    });
    const scene = pixiMock.containerInstances[0];
    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(pixiMock.spriteInstances).toHaveLength(1);
    expect(scene?.children).toEqual([pixiMock.spriteInstances[0], boxGraphics]);

    renderer.setPresentation({ maskStyle: new BaseMaskStyle() });

    expect(pixiMock.spriteInstances).toHaveLength(2);
    expect(scene?.children).toEqual([
      pixiMock.spriteInstances[0],
      pixiMock.spriteInstances[1],
      boxGraphics,
    ]);
    expect(pixiMock.appInit).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(pixiMock.textureOptions).toHaveLength(2);
    });

    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(pixiMock.spriteInstances[1]).toMatchObject({
      height: 720,
      texture: expect.any(Object),
      visible: true,
      width: 1280,
    });

    await renderer.play();
    flushAnimationFrame(20);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
      expect(pixiMock.textureOptions).toHaveLength(2);
    });

    expect(pixiMock.spriteInstances[1]).toMatchObject({
      height: 720,
      texture: expect.any(Object),
      visible: true,
      width: 1280,
    });

    renderer.destroy();
  });

  it("ignores presentation updates after destroy", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);

    renderer.destroy();

    expect(() =>
      renderer.setPresentation({
        boxStyle: null,
        maskStyle: new BaseMaskStyle(),
      }),
    ).not.toThrow();
    expect(pixiMock.appInit).toHaveBeenCalledOnce();
  });

  it("does not overlap prefetch reads while a sample iterator read is in flight", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    const deferred = createDeferred<MockVideoSample>();
    let iteratorNextCount = 0;
    let pendingReadCount = 0;

    mediaMock.getSample.mockClear();
    mediaMock.samplesImplementation = () =>
      ({
        async next() {
          pendingReadCount += 1;
          iteratorNextCount += 1;

          if (iteratorNextCount > 1) {
            return { done: true as const, value: undefined };
          }

          const value = await deferred.promise;

          return { done: false as const, value };
        },
        async return() {
          await mediaMock.iteratorReturn();
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      }) as AsyncGenerator<MockVideoSample, void, unknown>;

    await renderer.play();
    await vi.waitFor(() => {
      expect(pendingReadCount).toBe(1);
    });
    flushAnimationFrame(40);

    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(pendingReadCount).toBe(1);
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
    const deferred = createDeferred<MockVideoSample>();
    let iteratorNextCount = 0;
    let pendingReadCount = 0;

    mediaMock.getSample.mockClear();
    mediaMock.samplesImplementation = () =>
      ({
        async next() {
          pendingReadCount += 1;
          iteratorNextCount += 1;

          if (iteratorNextCount > 1) {
            return { done: true as const, value: undefined };
          }

          const value = await deferred.promise;

          return { done: false as const, value };
        },
        async return() {
          await mediaMock.iteratorReturn();
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      }) as AsyncGenerator<MockVideoSample, void, unknown>;

    await renderer.play();
    await vi.waitFor(() => {
      expect(pendingReadCount).toBe(1);
    });
    renderer.pause();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.getSample).not.toHaveBeenCalled();
    expect(mediaMock.samples[1].draw).not.toHaveBeenCalled();
    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Paused,
    );

    renderer.destroy();
  });

  it("destroy prevents late async samples from drawing", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false);
    const deferred = createDeferred<MockVideoSample>();
    let iteratorNextCount = 0;
    let pendingReadCount = 0;

    mediaMock.getSample.mockClear();
    mediaMock.samplesImplementation = () =>
      ({
        async next() {
          pendingReadCount += 1;
          iteratorNextCount += 1;

          if (iteratorNextCount > 1) {
            return { done: true as const, value: undefined };
          }

          const value = await deferred.promise;

          return { done: false as const, value };
        },
        async return() {
          await mediaMock.iteratorReturn();
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      }) as AsyncGenerator<MockVideoSample, void, unknown>;

    await renderer.play();
    await vi.waitFor(() => {
      expect(pendingReadCount).toBe(1);
    });
    renderer.destroy();
    deferred.resolve(mediaMock.samples[1]);

    await vi.waitFor(() => {
      expect(mediaMock.samples[1].close).toHaveBeenCalledOnce();
    });
    expect(mediaMock.getSample).not.toHaveBeenCalled();
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

  it("reports a helpful error when both detectionFrames and detectionSource are supplied", async () => {
    resetMocks();

    const renderer = await createRenderer(false, false, {
      detectionFrames: [],
      detectionSource: {
        loadFrames: vi.fn(async () => []),
      },
    });

    expect(renderer.getState().playbackState).toBe(
      MediaRendererPlaybackState.Error,
    );
    expect(renderer.getState().source).toMatchObject({
      errorMessage:
        "Provide either detectionFrames or detectionSource, not both.",
      status: MediaSourceStatus.Error,
    });
    expect(pixiMock.stageAddChild).not.toHaveBeenCalled();

    renderer.destroy();
  });
});
