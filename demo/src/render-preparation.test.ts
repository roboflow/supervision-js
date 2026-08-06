import { describe, expect, it } from "vitest";

import {
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationDiagnostics,
} from "supervision";
import { selectPreparedWindowArtifact } from "./render-preparation";

describe("render preparation diagnostics", () => {
  it.each([
    RenderPreparationArtifactKind.MaskFrame,
    RenderPreparationArtifactKind.PolygonFrame,
  ])("selects the prepared window for %s artifacts", (kind) => {
    const artifact = {
      kind,
      pendingCount: 2,
      preparedAheadFrameCount: 18,
      preparedAheadSeconds: 0.6,
      preparedCount: 24,
      window: {
        availableFrameCount: 30,
        refillThresholdFrameCount: 12,
        targetFrameCount: 24,
      },
    };
    const diagnostics: RenderPreparationDiagnostics = {
      artifacts: [artifact],
      executionMode: RenderPreparationExecutionMode.Worker,
      message: null,
      workerStatus: RenderPreparationWorkerStatus.Ready,
    };

    expect(selectPreparedWindowArtifact(diagnostics)).toBe(artifact);
  });

  it("returns no prepared window when diagnostics are unavailable", () => {
    expect(selectPreparedWindowArtifact(null)).toBeNull();
  });
});
