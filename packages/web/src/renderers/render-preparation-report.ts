import {
  RenderPreparationExecutionMode,
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
 * Masks, polygons and depth each report on their own schedule; merging them
 * keeps a host that holds the last report it heard from seeing one family
 * replace another.
 */
export interface RenderPreparationReport {
  /** Returns the merged report of every family. */
  update(
    family: string,
    diagnostics: RenderPreparationDiagnostics,
  ): RenderPreparationDiagnostics;
  /**
   * Returns the merged report of the families left, empty when none is, or
   * null when `family` was not reporting.
   */
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
      return (
        merged() ?? {
          artifacts: [],
          executionMode: RenderPreparationExecutionMode.MainThread,
          message: null,
          workerStatus: RenderPreparationWorkerStatus.Disabled,
        }
      );
    },
  };
}

/**
 * The worker status is the worst any family reports, with that family's
 * execution mode, so a worker that failed stays visible beside one that is
 * fine.
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
