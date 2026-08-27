import { describe, expect, it } from "vitest";

import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import { DetectionBufferStatus } from "#types/detection-timeline";
import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
  DetectionFrameSourceVersionRange,
  LiveWritableDetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
} from "#types/media-rendering";
import type {
  MediaRendererState,
  MediaSourceState,
} from "#types/media-rendering";
import type { DetectionFrame } from "#types/detections";

/**
 * These fixtures are written against the public shapes as they existed before
 * live ingestion, coverage finalization, and typed media errors were added.
 * They exist to fail `typecheck` if any of those additions ever becomes a
 * required member again, because that would break structurally typed consumer
 * code that never opted into the new capabilities.
 */

const emptySummary: ColdDetectionFrameStoreWriteSummary = {
  chunkCount: 0,
  chunkDurationSeconds: 1,
  datasetId: "legacy",
  detectionCount: 0,
  endTime: null,
  frameCount: 0,
  startTime: null,
};

/** A writable source implemented before `appendLiveFrame` existed. */
const legacyWritableSource: WritableDetectionFrameSource = {
  datasetId: "legacy",
  async appendFrames() {
    return emptySummary;
  },
  async replaceFrames() {
    return emptySummary;
  },
  async clear() {},
  async loadFrames(): Promise<readonly DetectionFrame[]> {
    return [];
  },
  async waitForRange(range: DetectionFrameSourceVersionRange) {
    void range;
  },
  getAvailableRanges(): readonly DetectionFrameSourceVersionRange[] {
    return [];
  },
  getSummary() {
    return null;
  },
  getVersion() {
    return 0;
  },
};

/** A source state fixture written before `errorKind` existed. */
const legacySourceState: MediaSourceState = {
  audioTrackCount: null,
  canRead: true,
  duration: 9,
  errorMessage: null,
  estimatedFrameCount: null,
  estimatedFrameRate: null,
  firstTimestamp: 0,
  formatMimeType: "video/mp4",
  formatName: "MP4",
  mimeType: "video/mp4",
  primaryVideoHeight: 720,
  primaryVideoWidth: 1280,
  status: MediaSourceStatus.Ready,
  trackCount: 1,
  videoTrackCount: 1,
};

/** A renderer state written before the mask layer reported what it drew. */
const legacyRendererState: MediaRendererState = {
  activeDetectionCount: 0,
  activeDetectionFrameIndex: null,
  activeDetectionFrameTime: null,
  currentTime: 0,
  detectionBuffer: {
    bufferEndTime: null,
    bufferStartTime: null,
    detectionCount: 0,
    errorMessage: null,
    frameCount: 0,
    requestedEndTime: null,
    requestedStartTime: null,
    status: DetectionBufferStatus.Idle,
  },
  duration: 9,
  fit: MediaRendererFit.Contain,
  lastFrameRenderTimings: null,
  mediaHeight: 720,
  mediaWidth: 1280,
  playbackRate: 1,
  playbackState: MediaRendererPlaybackState.Ready,
  presentedFrames: 0,
  rendererBackend: null,
  source: legacySourceState,
};

/** A cold store implemented before optional in-place pruning existed. */
const legacyStore: ColdDetectionFrameStore = {
  async putFrames() {
    return emptySummary;
  },
  async appendFrames() {
    return emptySummary;
  },
  async loadFrames(): Promise<readonly DetectionFrame[]> {
    return [];
  },
  async clearDataset() {},
};

describe("public contract compatibility", () => {
  it("keeps sources written before live ingestion assignable", () => {
    expect(legacyWritableSource.appendLiveFrame).toBeUndefined();
    expect(legacyWritableSource.finalizeCoverage).toBeUndefined();
  });

  it("keeps media source states written before typed errors assignable", () => {
    expect(legacySourceState.errorKind ?? null).toBeNull();
  });

  it("keeps renderer states written before the mask readouts assignable", () => {
    expect(legacyRendererState.presentedFrames).toBe(0);
    expect(legacyRendererState.drawnMaskFrameTime).toBeUndefined();
    expect(legacyRendererState.maskHeldStale).toBeUndefined();
  });

  it("keeps cold stores written before in-place pruning assignable", () => {
    expect(legacyStore.pruneFrames).toBeUndefined();
  });

  it("narrows the built-in source to the live capability", () => {
    const source: LiveWritableDetectionFrameSource =
      createWritableDetectionSource();

    expect(typeof source.appendLiveFrame).toBe("function");
    expect(typeof source.finalizeCoverage).toBe("function");
  });
});

function createWritableDetectionSource() {
  return createWritableDetectionFrameSource({
    datasetId: "live",
    store: createMemoryColdDetectionFrameStore(),
  });
}
