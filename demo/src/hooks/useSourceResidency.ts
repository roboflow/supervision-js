import { useEffect, useState } from "react";
import type { SourceResidencyDiagnostics } from "supervision-js-video-engine";

import type { EngineDiagnosticsTap } from "../diagnostics/engine-diagnostics-tap";

/**
 * The engine's held source bytes, sampled from its diagnostics broadcast.
 *
 * The broadcast is worker work the engine only does while something reads it, so
 * a page that did not ask for residency leaves it stopped and the lane reads off
 * a snapshot nobody took.
 */
export function useSourceResidency(
  tap: EngineDiagnosticsTap,
  enabled: boolean,
): SourceResidencyDiagnostics | null {
  const [residency, setResidency] = useState<SourceResidencyDiagnostics | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const stop = tap.start();
    const read = () => {
      const next = tap.read()?.sourceResidency ?? null;

      setResidency((previous) =>
        sameResidency(previous, next) ? previous : next,
      );
    };
    const unsubscribe = tap.subscribe(read);

    read();

    return () => {
      unsubscribe();
      stop();
    };
  }, [enabled, tap]);

  return residency;
}

/** Ten broadcasts a second, most of them carrying the runs the last one did. */
function sameResidency(
  previous: SourceResidencyDiagnostics | null,
  next: SourceResidencyDiagnostics | null,
) {
  if (previous === null || next === null) {
    return previous === next;
  }

  return (
    previous.residentBytes === next.residentBytes &&
    previous.totalBytes === next.totalBytes &&
    previous.warming === next.warming &&
    previous.ranges.length === next.ranges.length &&
    previous.ranges.every(
      (range, index) =>
        range.start === next.ranges[index]?.start &&
        range.end === next.ranges[index]?.end,
    )
  );
}
