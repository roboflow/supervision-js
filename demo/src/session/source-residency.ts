import type { SourceResidencyConfig } from "supervision-js-video-engine";

/** Mebibytes held when residency is on and nothing says how many. */
export const DEMO_SOURCE_RESIDENCY_BUDGET_MB = 160;

/**
 * The residency the page URL asks for, which is where the Session panel's own
 * control starts: `?residency=hold` serves repeat reads from bytes already
 * pulled, `?residency=prefetch` also walks the rest of the file in the
 * background, and `?residencyMb=` sets the ceiling, so a deployed build can open
 * straight into either one.
 */
export function readDemoSourceResidency(
  search: string,
): SourceResidencyConfig | undefined {
  const params = new URLSearchParams(search);
  const mode = params.get("residency");
  if (mode !== "hold" && mode !== "prefetch") return undefined;
  const requestedMb = Number(params.get("residencyMb"));
  const budgetMb =
    Number.isFinite(requestedMb) && requestedMb > 0
      ? requestedMb
      : DEMO_SOURCE_RESIDENCY_BUDGET_MB;
  return {
    budgetBytes: Math.round(budgetMb * 1024 * 1024),
    prefetch: mode === "prefetch",
  };
}
