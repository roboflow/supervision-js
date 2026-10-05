import { describe, expect, it } from "vitest";

import {
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";
import { createRenderPreparationReport } from "./render-preparation-report";

const masks: RenderPreparationDiagnostics = {
  artifacts: [
    {
      kind: RenderPreparationArtifactKind.MaskFrame,
      pendingCount: 2,
      preparedCount: 10,
    },
  ],
  executionMode: RenderPreparationExecutionMode.Worker,
  message: null,
  workerStatus: RenderPreparationWorkerStatus.Ready,
};

const depth: RenderPreparationDiagnostics = {
  artifacts: [
    {
      kind: RenderPreparationArtifactKind.DepthFrame,
      pendingCount: 1,
      preparedCount: 30,
    },
    {
      kind: RenderPreparationArtifactKind.ExactDepthFrame,
      pendingCount: 0,
      preparedCount: 5,
    },
  ],
  executionMode: RenderPreparationExecutionMode.MainThread,
  message: "The depth preview is off.",
  workerStatus: RenderPreparationWorkerStatus.Disabled,
};

describe("render preparation report", () => {
  it("keeps masks and depth side by side instead of one replacing the other", () => {
    const report = createRenderPreparationReport();

    expect(report.update("maskFrame", masks)).toBe(masks);

    const both = report.update("depth", depth);

    expect(both.artifacts.map((artifact) => artifact.kind)).toEqual([
      RenderPreparationArtifactKind.MaskFrame,
      RenderPreparationArtifactKind.DepthFrame,
      RenderPreparationArtifactKind.ExactDepthFrame,
    ]);
    expect(both).toMatchObject({
      executionMode: RenderPreparationExecutionMode.Worker,
      message: "The depth preview is off.",
      workerStatus: RenderPreparationWorkerStatus.Ready,
    });

    const later = report.update("maskFrame", {
      ...masks,
      artifacts: [{ ...masks.artifacts[0], pendingCount: 0 }],
    });

    expect(later.artifacts).toHaveLength(3);
    expect(later.artifacts[0].pendingCount).toBe(0);
  });

  it("keeps a failed worker visible whichever family reports after it", () => {
    const report = createRenderPreparationReport();

    report.update("maskFrame", {
      ...masks,
      message: "worker crashed",
      workerStatus: RenderPreparationWorkerStatus.Error,
    });

    expect(report.update("depth", depth)).toMatchObject({
      message: "worker crashed The depth preview is off.",
      workerStatus: RenderPreparationWorkerStatus.Error,
    });
  });

  it("drops a family that stopped, and says when none is left", () => {
    const report = createRenderPreparationReport();

    report.update("maskFrame", masks);
    report.update("depth", depth);

    expect(report.remove("depth")).toBe(masks);
    expect(report.remove("maskFrame")).toMatchObject({
      artifacts: [],
      message: null,
    });
    expect(report.remove("depth")).toBeNull();
  });
});
