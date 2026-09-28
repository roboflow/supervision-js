import { describe, expect, it } from "vitest";
import type { Detection } from "supervision";
import manifest from "../../fixtures/pebbles_anomaly/detections.manifest.json";
import early from "../../fixtures/pebbles_anomaly/detections/000000.json";
import bolt from "../../fixtures/pebbles_anomaly/detections/000003.json";
import raw from "../../fixtures/pebbles_anomaly/raw-patrick-detections.json";

const chunks = import.meta.glob(
  "../../fixtures/pebbles_anomaly/detections/*.json",
  { eager: true, import: "default" },
) as Record<
  string,
  { frames: Array<{ frameIndex: number; detections: Detection[] }> }
>;

describe("Patrick pebbles fixture", () => {
  it("preserves source coordinates and the playable frame grid", () => {
    expect(manifest.video).toMatchObject({
      width: 3600,
      height: 1570,
      frameCount: 320,
    });
    expect(raw.frames).toHaveLength(341);
    expect(early.frames[0].frameIndex).toBe(0);
    expect(early.frames[0].detections).toHaveLength(0);
  });

  it("keeps confirmed tracks and scalar heat at the bolt frame", () => {
    const frame = bolt.frames.find((candidate) => candidate.frameIndex === 109);
    expect(frame).toBeDefined();
    const detection = frame!.detections.find(
      (candidate) => candidate.trackerId === 5 && "heatmap" in candidate,
    ) as Detection | undefined;
    expect(detection?.className).toBe("bolt");
    expect(detection?.metadata?.state).toBe("hit");
    expect(detection?.heatmap?.threshold).toBeCloseTo(raw.anomaly_threshold);
    expect(detection?.heatmap?.values).toHaveLength(
      detection!.heatmap!.width * detection!.heatmap!.height,
    );
    expect(
      Math.max(...detection!.heatmap!.values) * detection!.heatmap!.valueScale!,
    ).toBeCloseTo(raw.frames[109].heat_max, 4);
  });

  it("preserves every playable tracker state and only adds heat on hits", () => {
    const frames = Object.values(chunks)
      .flatMap((chunk) => chunk.frames)
      .sort((left, right) => left.frameIndex - right.frameIndex);
    const trackIds = new Set<number>();
    let heatmapCount = 0;

    expect(frames).toHaveLength(manifest.frameCount);
    for (const [index, frame] of frames.entries()) {
      const original = raw.frames[index]!;
      expect(frame.frameIndex).toBe(original.frame);
      expect(frame.detections).toHaveLength(original.anomalies.length);
      for (const [offset, detection] of frame.detections.entries()) {
        const anomaly = original.anomalies[offset]!;
        trackIds.add(anomaly.tracker_id);
        expect(detection.trackerId).toBe(anomaly.tracker_id);
        expect(detection.metadata?.state).toBe(anomaly.state);
        const [x0, y0, x1, y1] = anomaly.xyxy;
        expect(detection.rect).toEqual({
          x: (x0 + x1) / 2,
          y: (y0 + y1) / 2,
          width: x1 - x0,
          height: y1 - y0,
        });
        expect(detection.heatmap !== undefined).toBe(anomaly.state === "hit");
        if (detection.heatmap) heatmapCount += 1;
      }
    }
    expect([...trackIds].sort((left, right) => left - right)).toEqual([5, 23]);
    expect(heatmapCount).toBe(manifest.geometry.heatmapDetectionCount);
  });
});
