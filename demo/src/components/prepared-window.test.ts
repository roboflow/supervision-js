import { describe, expect, it } from "vitest";
import {
  RenderPreparationArtifactKind,
  type RenderPreparationArtifactDiagnostics,
} from "supervision";
import { readPreparedWindow } from "./prepared-window";

function artifact(
  patch: Partial<RenderPreparationArtifactDiagnostics>,
): RenderPreparationArtifactDiagnostics {
  return {
    kind: RenderPreparationArtifactKind.MaskFrame,
    pendingCount: 0,
    preparedCount: 0,
    ...patch,
  };
}

describe("readPreparedWindow", () => {
  it("reports the reach the cook published", () => {
    const reading = readPreparedWindow(
      artifact({ preparedAheadFrameCount: 211, preparedAheadSeconds: 7 }),
      30,
    );

    expect(reading?.cookedFrameCount).toBe(211);
    expect(reading?.cookedSeconds).toBeCloseTo(7, 5);
  });

  it("takes the target from the frames the cook selected", () => {
    const reading = readPreparedWindow(
      artifact({
        prefetchCount: 211,
        preparedAheadFrameCount: 12,
        preparedAheadSeconds: 0.4,
        window: {
          availableFrameCount: 900,
          refillThresholdFrameCount: 12,
          targetFrameCount: 17,
        },
      }),
      30,
    );

    expect(reading?.targetFrameCount).toBe(17);
    expect(reading?.targetSeconds).toBeCloseTo(17 / 30, 5);
  });

  it("never reports a target the cooked run has already passed", () => {
    const reading = readPreparedWindow(
      artifact({
        preparedAheadFrameCount: 30,
        preparedAheadSeconds: 1,
        window: {
          availableFrameCount: 90,
          refillThresholdFrameCount: 5,
          targetFrameCount: 12,
        },
      }),
      30,
    );

    expect(reading?.targetFrameCount).toBe(30);
  });

  it("falls back to a 60Hz pitch when the source reported no rate", () => {
    const reading = readPreparedWindow(
      artifact({ preparedAheadFrameCount: 60, preparedAheadSeconds: 1 }),
      null,
    );

    expect(reading?.targetSeconds).toBeCloseTo(1, 5);
  });

  it("reads nothing from an artifact that publishes no prepared run", () => {
    expect(readPreparedWindow(artifact({}), 30)).toBeNull();
    expect(readPreparedWindow(null, 30)).toBeNull();
  });
});
