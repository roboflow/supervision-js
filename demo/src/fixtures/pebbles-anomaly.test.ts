import { describe, expect, it } from "vitest";
import type { Detection } from "supervision";
import manifest from "../../fixtures/pebbles_anomaly/detections.manifest.json";
import early from "../../fixtures/pebbles_anomaly/detections/000000.json";
import bolt from "../../fixtures/pebbles_anomaly/detections/000003.json";
import raw from "../../fixtures/pebbles_anomaly/raw-patrick-detections.json";

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
});
