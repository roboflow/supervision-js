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
  applyDemoRendererOptions,
  applyDemoSessionPlaybackGate,
  buildDemoNormalization,
  normalizationSupported,
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
    expect(buildDemoNormalization({})).toBeUndefined();
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
      bufferBehindSeconds: 0.5,
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
      buildDemoNormalization({
        normalize: true,
        normalizeContainer: MediaNormalizationContainer.Mp4,
        normalizeVideoCodec: MediaNormalizationVideoCodec.Avc,
      }),
    ).toEqual({
      container: MediaNormalizationContainer.Mp4,
      video: { codec: MediaNormalizationVideoCodec.Avc },
    });
    expect(buildDemoNormalization({ normalize: true })).toEqual({});
  });

  it("reports the defaults the library resolves for the open session", () => {
    const configuration = resolveDemoSessionConfiguration({
      detections: baseDetections,
      mode: MediaSessionMode.File,
      normalizable: normalizationSupported,
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
