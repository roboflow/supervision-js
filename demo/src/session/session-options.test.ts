import { describe, expect, it } from "vitest";
import {
  MediaInteractionMode,
  MediaNormalizationContainer,
  MediaNormalizationVideoCodec,
  MediaRendererFit,
  MediaSessionMode,
  RenderPreparationMode,
  resolveMediaSessionDefaults,
  type MediaSessionDetectionOptions,
  type MediaSessionRendererOptions,
} from "supervision";
import {
  applyDemoDetectionOptions,
  applyDemoEngineOptions,
  applyDemoMediaPath,
  applyDemoRendererOptions,
  applyDemoSessionPlaybackGate,
  buildDemoNormalization,
  DemoEngineSource,
  DemoMediaPath,
  DemoSourceResidency,
  optionSupported,
  resolveDemoSessionConfiguration,
} from "./session-options";

const baseDetections: MediaSessionDetectionOptions = {
  frames: [],
  sync: { frameRate: 24 },
};

const baseRenderer: MediaSessionRendererOptions = {
  autoPlay: false,
  fit: MediaRendererFit.Contain,
  interaction: { mode: MediaInteractionMode.PausedOnly },
  loop: true,
  renderPreparation: {
    maskFrame: {
      display: { boxHeight: 200, boxWidth: 400, devicePixelRatio: 2 },
    },
    mode: RenderPreparationMode.Worker,
  },
};

describe("demo session options", () => {
  it("leaves the session it would otherwise build untouched", () => {
    expect(applyDemoDetectionOptions(baseDetections, {})).toEqual(
      baseDetections,
    );
    expect(applyDemoRendererOptions(baseRenderer, {})).toEqual(baseRenderer);
    expect(applyDemoSessionPlaybackGate(true, {})).toBe(true);
    expect(applyDemoMediaPath({})).toBe(DemoMediaPath.Engine);
    expect(
      buildDemoNormalization(DemoMediaPath.Mediabunny, {}),
    ).toBeUndefined();
    expect(applyDemoEngineOptions({}, {})).toEqual({});
  });

  it("leaves the clip to the library only when the panel asks for it", () => {
    expect(applyDemoMediaPath({ mediaPath: DemoMediaPath.Mediabunny })).toBe(
      DemoMediaPath.Mediabunny,
    );
  });

  it("converts nothing while the video engine is the one opening the clip", () => {
    expect(
      buildDemoNormalization(DemoMediaPath.Engine, { normalize: true }),
    ).toBeUndefined();
    expect(
      buildDemoNormalization(DemoMediaPath.Mediabunny, { normalize: true }),
    ).toEqual({});
  });

  it("keeps the residency the page URL opened with until the panel says otherwise", () => {
    const opened = { budgetBytes: 32 * 1024 * 1024, prefetch: false };

    expect(applyDemoEngineOptions({ sourceResidency: opened }, {})).toEqual({
      sourceResidency: opened,
    });
    expect(
      applyDemoEngineOptions(
        { sourceResidency: opened },
        { sourceResidency: DemoSourceResidency.Prefetch },
      ).sourceResidency,
    ).toEqual({ budgetBytes: 32 * 1024 * 1024, prefetch: true });
    expect(
      applyDemoEngineOptions(
        { sourceResidency: opened },
        { sourceResidency: DemoSourceResidency.Off },
      ).sourceResidency,
    ).toBeUndefined();
  });

  it("states the panel's mebibytes as the bytes the engine reads", () => {
    expect(
      applyDemoEngineOptions(
        {},
        { sourceResidency: DemoSourceResidency.Hold, urlSourceMaxCacheMb: 256 },
      ),
    ).toEqual({
      sourceResidency: { budgetBytes: 160 * 1024 * 1024, prefetch: false },
      urlSource: { maxCacheSize: 256 * 1024 * 1024 },
    });
  });

  it("changes one buffer knob without disturbing its siblings", () => {
    const detections = applyDemoDetectionOptions(baseDetections, {
      bufferAheadSeconds: 4,
    });

    expect(detections.buffer).toEqual({ bufferAheadSeconds: 4 });
    expect(detections.sync).toBe(baseDetections.sync);
    expect(
      resolveMediaSessionDefaults({ detections }).detectionBuffer,
    ).toMatchObject({
      bufferAheadSeconds: 4,
      bufferBehindSeconds: 5,
      refreshIntervalSeconds: 2.5,
    });
  });

  it("keeps the demo's own mask display box while retuning the window", () => {
    const renderer = applyDemoRendererOptions(baseRenderer, {
      maskPrefetchFrameCount: 12,
    });

    expect(renderer.renderPreparation?.maskFrame).toEqual({
      display: { boxHeight: 200, boxWidth: 400, devicePixelRatio: 2 },
      prefetchFrameCount: 12,
    });
    expect(renderer.renderPreparation?.mode).toBe(RenderPreparationMode.Worker);
  });

  it("reads an explicitly unset playback gate apart from an absent choice", () => {
    expect(applyDemoSessionPlaybackGate(true, { playbackGate: "unset" })).toBe(
      undefined,
    );
    expect(applyDemoSessionPlaybackGate(true, { playbackGate: false })).toBe(
      false,
    );
  });

  it("builds normalization only from the fields that were chosen", () => {
    expect(
      buildDemoNormalization(DemoMediaPath.Mediabunny, {
        normalize: true,
        normalizeContainer: MediaNormalizationContainer.Mp4,
        normalizeVideoCodec: MediaNormalizationVideoCodec.Avc,
      }),
    ).toEqual({
      container: MediaNormalizationContainer.Mp4,
      video: { codec: MediaNormalizationVideoCodec.Avc },
    });
  });

  it("reports the defaults the library resolves for the open session", () => {
    const configuration = resolveDemoSessionConfiguration({
      detections: baseDetections,
      engine: {},
      engineSource: DemoEngineSource.Url,
      mediaPath: DemoMediaPath.Engine,
      mediaPathSupport: optionSupported,
      mode: MediaSessionMode.File,
      normalizationSupport: optionSupported,
      playbackGate: true,
      renderer: baseRenderer,
    });

    expect(configuration.resolved).toEqual(
      resolveMediaSessionDefaults({
        detections: baseDetections,
        mode: MediaSessionMode.File,
        playbackGate: true,
        renderer: baseRenderer,
      }),
    );
    expect(configuration.resolved.detectionBuffer.playbackGate).toEqual({
      enabled: true,
      maxWaitSeconds: 10,
      requiredAheadSeconds: 2,
    });
    // Seven seconds of prefetch and eight of cache, at the detection rate.
    expect(configuration.resolved.renderPreparation.maskFrame).toMatchObject({
      maxCacheFrameCount: 192,
      prefetchFrameCount: 168,
    });
    expect(configuration.autoPlay).toBe(false);
    expect(configuration.preparationMode).toBe(RenderPreparationMode.Worker);
  });
});
