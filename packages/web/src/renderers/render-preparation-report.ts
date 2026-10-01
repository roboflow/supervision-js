import {
  RenderPreparationWorkerStatus,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

/** Worse statuses outrank better ones when families are reported together. */
const WORKER_STATUS_RANK: Record<RenderPreparationWorkerStatus, number> = {
  [RenderPreparationWorkerStatus.Disabled]: 0,
  [RenderPreparationWorkerStatus.Ready]: 1,
  [RenderPreparationWorkerStatus.Unavailable]: 2,
  [RenderPreparationWorkerStatus.Error]: 3,
};

/**
 * One diagnostics report for every family that prepares artifacts. Masks,
 * polygons and depth each report on their own schedule; a host holding the
 * last report it heard would otherwise see one family replace another.
 */
export interface RenderPreparationReport {
  /** Records `family`'s latest report and returns what every family says now. */
  update(
    family: string,
    diagnostics: RenderPreparationDiagnostics,
  ): RenderPreparationDiagnostics;
  /** `family` stopped preparing; null when no family is left. */
  remove(family: string): RenderPreparationDiagnostics | null;
}

export function createRenderPreparationReport(): RenderPreparationReport {
  const reports = new Map<string, RenderPreparationDiagnostics>();

  const merged = () => mergeRenderPreparationDiagnostics([...reports.values()]);

  return {
    update(family, diagnostics) {
      reports.set(family, diagnostics);
      return merged()!;
    },
    remove(family) {
      if (!reports.delete(family)) return null;
      return merged();
    },
  };
}

/**
 * Every family's artifacts in one report. The worker status is the worst any
 * family reports, with that family's execution mode, so a worker that failed
 * stays visible beside one that is fine; messages are kept side by side.
 */
export function mergeRenderPreparationDiagnostics(
  reports: readonly RenderPreparationDiagnostics[],
): RenderPreparationDiagnostics | null {
  if (reports.length <= 1) return reports[0] ?? null;

  const worst = reports.reduce((current, report) =>
    WORKER_STATUS_RANK[report.workerStatus] >
    WORKER_STATUS_RANK[current.workerStatus]
      ? report
      : current,
  );
  const messages = [
    ...new Set(
      reports
        .map((report) => report.message)
        .filter((message): message is string => Boolean(message)),
    ),
  ];

  return {
    artifacts: reports.flatMap((report) => report.artifacts),
    executionMode: worst.executionMode,
    message: messages.length === 0 ? null : messages.join(" "),
    workerStatus: worst.workerStatus,
  };
}
