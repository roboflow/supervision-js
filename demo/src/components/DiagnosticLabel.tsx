import { memo } from "react";

/**
 * A reading's name, small enough that it cannot explain itself, paired with the
 * sentence that does. The name is a focusable target so the explanation is
 * reachable without a pointer, and it repeats in the accessible name because a
 * screen reader never sees the tooltip open.
 */
export const DiagnosticLabel = memo(function DiagnosticLabel({
  align = "start",
  label,
  tooltip,
}: {
  readonly align?: "end" | "start";
  readonly label: string;
  readonly tooltip: string;
}) {
  return (
    <span className="diagnostic-label">
      <button
        aria-label={`${label}. ${tooltip}`}
        className="diagnostic-label__name"
        type="button"
      >
        {label}
      </button>
      <span
        className={`diagnostic-label__tip diagnostic-label__tip--${align}`}
        role="tooltip"
      >
        {tooltip}
      </span>
    </span>
  );
});
