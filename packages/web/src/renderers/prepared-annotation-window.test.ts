import { beforeEach, describe, expect, it } from "vitest";
import {
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
} from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionFrame,
} from "supervision-js-core";

import { createPreparedAnnotationWindow } from "#renderers/prepared-annotation-window";
import type { PreparedAnnotationLayer } from "#renderers/prepared-annotation-window";

const frames: readonly DetectionFrame[] = [
  { detections: [], frameIndex: 0, mediaTime: 0 },
  { detections: [], frameIndex: 1, mediaTime: 0.1 },
  { detections: [], frameIndex: 2, mediaTime: 0.2 },
];

let detectionTimeline: BufferedDetectionTimeline;

beforeEach(async () => {
  detectionTimeline = createBufferedDetectionTimeline({
    source: createArrayDetectionFrameSource(frames),
  });
  await detectionTimeline.prepare(0);
});

describe("prepared annotation window", () => {
  it("hands over a frame no layer has cooked yet", () => {
    const masks = createCook([]);
    const polygons = createCook([]);
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [masks, polygons],
      getPlayheadMediaTime: () => 0,
    });

    expect(window.getPreparedFrame(0)).toBe(detectionTimeline.selectFrame(0));
    expect(window.getSnapshot().playheadPrepared).toBe(false);

    masks.prepared.add("0");
    polygons.prepared.add("0");

    expect(window.getSnapshot().playheadPrepared).toBe(true);
  });

  it("answers with no frame at all where detections are missing", () => {
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [],
      getPlayheadMediaTime: () => 0,
    });

    expect(window.getPreparedFrame(9)).toBeNull();
    expect(window.preparedFrameTimeline.selectFrame(9)).toBeUndefined();
  });

  it("hands the layers a buffered frame whatever the cooks owe on it", () => {
    const masks = createCook(["0"]);
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [masks],
      getPlayheadMediaTime: () => 0,
    });

    expect(window.preparedFrameTimeline.selectFrame(0)).toBe(
      detectionTimeline.selectFrame(0),
    );
    expect(window.preparedFrameTimeline.selectFrame(0.1)).toBe(
      detectionTimeline.selectFrame(0.1),
    );
  });

  it("reports the span and each frame's readiness", () => {
    const masks = createCook(["0", "2"]);
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [masks],
      getPlayheadMediaTime: () => 0,
    });
    const snapshot = window.getSnapshot();

    expect(snapshot.frames).toStrictEqual([
      { frameIndex: 0, mediaTime: 0, prepared: true },
      { frameIndex: 1, mediaTime: 0.1, prepared: false },
      { frameIndex: 2, mediaTime: 0.2, prepared: true },
    ]);
    expect(snapshot).toMatchObject({
      playheadMediaTime: 0,
      playheadPrepared: true,
      preparedFrameCount: 2,
      spanFrameCount: 12,
    });
  });

  it("spans from the frame under the playhead, not from the playhead", () => {
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [],
      getPlayheadMediaTime: () => 0.15,
    });

    expect(window.getSnapshot().frames.map((frame) => frame.mediaTime)).toEqual(
      [0.1, 0.2],
    );
  });

  it("moves its readiness token when one layer lands a frame others still owe", () => {
    const masks = createCook([]);
    const polygons = createCook([]);
    const window = createPreparedAnnotationWindow({
      detectionTimeline,
      getLayers: () => [masks, polygons],
      getPlayheadMediaTime: () => 0,
    });
    const owed = window.getReadinessToken(0);

    masks.prepared.add("0");

    expect(window.getReadinessToken(0)).not.toBe(owed);
    expect(window.getSnapshot().frames[0]).toMatchObject({ prepared: false });
  });
});

function createCook(preparedFrameIndexes: readonly string[]) {
  const prepared = new Set(preparedFrameIndexes);

  return {
    isArtifactPrepared(mediaTime: number) {
      const frame = detectionTimeline.selectFrame(mediaTime);

      return frame === undefined || prepared.has(String(frame.frameIndex));
    },
    prepared,
  } satisfies PreparedAnnotationLayer & { readonly prepared: Set<string> };
}
