import { describe, expect, it } from "vitest";

import {
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
} from "#types/detection-timeline";
import { MediaSessionMode } from "#types/media-session";

import {
  resolveMediaSessionDefaults,
  resolveMediaSessionWritableRetention,
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
        enabled: true,
        minimumAheadSeconds: 0.25,
        requiredAheadSeconds: 1,
      },
    });
  });

  it("defaults writable stream sessions to gated prediction playback and rolling retention", () => {
    const writable = {
      datasetId: "stream",
    };
    const defaults = resolveMediaSessionDefaults({
      detections: {
        writable,
      },
      mode: MediaSessionMode.Stream,
      renderer: {},
    });
    const retention = resolveMediaSessionWritableRetention({
      mode: MediaSessionMode.Stream,
      writable,
    });

    expect(defaults.detectionBuffer.playbackGate).toEqual({
      enabled: true,
      requiredAheadSeconds: 2,
    });
    expect(retention).toEqual({
      mode: DetectionFrameRetentionMode.PersistWindow,
      windowSeconds: 300,
    });
  });

  it("preserves explicit tuning overrides", () => {
    const writable = {
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
        writable,
      },
      mode: MediaSessionMode.File,
      renderer: {
        renderPreparation: {
          maskFrame: { prefetchFrameCount: 12, workerCount: 2 },
          playbackGate: { enabled: false },
        },
      },
    });
    const retention = resolveMediaSessionWritableRetention({
      mode: MediaSessionMode.File,
      writable,
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
