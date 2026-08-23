import { describe, expect, it } from "vitest";

import {
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
} from "supervision-js-core";
import { MediaSessionMode } from "#types/media-session";

import {
  resolveMediaSessionAppendableRetention,
  resolveMediaSessionDefaults,
} from "./media-session-defaults";

describe("media session defaults", () => {
  it("uses file-mode rendering and buffering defaults", () => {
    const defaults = resolveMediaSessionDefaults({
      detections: {
        buffer: {
          frameRate: 30,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
        source: { loadFrames: async () => [] },
      },
      mode: MediaSessionMode.File,
      renderer: {},
    });

    expect(defaults.detectionBuffer).toEqual({
      bufferAheadSeconds: 10,
      bufferBehindSeconds: 0.5,
      frameRate: 30,
      refreshIntervalSeconds: 0.5,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    });
    expect(defaults.renderPreparation).toMatchObject({
      maskFrame: {
        maxCacheFrameCount: 240,
        maxPendingFrameCount: 24,
        prefetchFrameCount: 210,
        scanIntervalSeconds: 0.1,
        scheduleBatchSize: 16,
      },
      playbackGate: {
        enabled: false,
        minimumAheadSeconds: 0.25,
        requiredAheadSeconds: 1,
      },
    });
  });

  it("applies session-level detection sync before explicit buffer overrides", () => {
    const defaults = resolveMediaSessionDefaults({
      detections: {
        buffer: {
          bufferAheadSeconds: 3,
          frameRate: 15,
        },
        source: { loadFrames: async () => [] },
        sync: {
          frameIndexOriginTime: 0.25,
          frameRate: 30,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      mode: MediaSessionMode.File,
      renderer: {},
    });

    expect(defaults.detectionBuffer).toMatchObject({
      bufferAheadSeconds: 3,
      frameIndexOriginTime: 0.25,
      frameRate: 15,
      selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
    });
  });

  it("sizes render-preparation windows from session-level detection sync", () => {
    const defaults = resolveMediaSessionDefaults({
      detections: {
        source: { loadFrames: async () => [] },
        sync: {
          frameRate: 10,
        },
      },
      mode: MediaSessionMode.File,
      renderer: {},
    });

    expect(defaults.renderPreparation.maskFrame).toMatchObject({
      maxCacheFrameCount: 80,
      prefetchFrameCount: 70,
    });
  });

  it("defaults appendable stream sessions to ungated prediction playback and rolling retention", () => {
    const appendable = {
      datasetId: "stream",
    };
    const defaults = resolveMediaSessionDefaults({
      detections: {
        appendable,
      },
      mode: MediaSessionMode.Stream,
      renderer: {},
    });
    const retention = resolveMediaSessionAppendableRetention({
      appendable,
      mode: MediaSessionMode.Stream,
    });

    expect(defaults.detectionBuffer.playbackGate).toEqual({
      enabled: false,
      requiredAheadSeconds: 2,
    });
    expect(retention).toEqual({
      mode: DetectionFrameRetentionMode.PersistWindow,
      windowSeconds: 300,
    });
  });

  it("defaults appendable file sessions to persistent detection storage", () => {
    const appendable = {
      datasetId: "file",
    };
    const defaults = resolveMediaSessionDefaults({
      detections: {
        appendable,
      },
      mode: MediaSessionMode.File,
      renderer: {},
    });
    const retention = resolveMediaSessionAppendableRetention({
      appendable,
      mode: MediaSessionMode.File,
    });

    expect(defaults.detectionBuffer.playbackGate).toEqual({
      enabled: false,
      requiredAheadSeconds: 2,
    });
    expect(retention).toEqual({
      mode: DetectionFrameRetentionMode.PersistAll,
    });
  });

  it("carries an opted-in playback gate through to both resolved configs", () => {
    const defaults = resolveMediaSessionDefaults({
      detections: {
        appendable: { datasetId: "stream" },
        playbackGate: { enabled: true },
      },
      mode: MediaSessionMode.Stream,
      renderer: {
        renderPreparation: {
          playbackGate: { enabled: true },
        },
      },
    });

    expect(defaults.detectionBuffer.playbackGate).toEqual({
      enabled: true,
      requiredAheadSeconds: 2,
    });
    expect(defaults.renderPreparation.playbackGate).toEqual({
      enabled: true,
      minimumAheadSeconds: 0.25,
      requiredAheadSeconds: 1,
    });
  });

  it("preserves explicit tuning overrides", () => {
    const appendable = {
      datasetId: "upload",
      retention: {
        mode: DetectionFrameRetentionMode.MemoryOnly,
        windowSeconds: 45,
      },
    };
    const defaults = resolveMediaSessionDefaults({
      detections: {
        buffer: {
          bufferAheadSeconds: 3,
          playbackGate: { enabled: false },
        },
        playbackGate: { requiredAheadSeconds: 4 },
        appendable,
      },
      mode: MediaSessionMode.File,
      renderer: {
        renderPreparation: {
          maskFrame: { prefetchFrameCount: 12, workerCount: 2 },
          playbackGate: { enabled: false },
        },
      },
    });
    const retention = resolveMediaSessionAppendableRetention({
      appendable,
      mode: MediaSessionMode.File,
    });

    expect(defaults.detectionBuffer).toMatchObject({
      bufferAheadSeconds: 3,
      bufferBehindSeconds: 0.5,
      playbackGate: {
        enabled: false,
        requiredAheadSeconds: 4,
      },
    });
    expect(defaults.renderPreparation).toMatchObject({
      maskFrame: {
        maxCacheFrameCount: 240,
        prefetchFrameCount: 12,
        workerCount: 2,
      },
      playbackGate: {
        enabled: false,
        minimumAheadSeconds: 0.25,
        requiredAheadSeconds: 1,
      },
    });
    expect(retention).toEqual({
      mode: DetectionFrameRetentionMode.MemoryOnly,
      windowSeconds: 45,
    });
  });
});
