import { memo, type CSSProperties, type ReactNode } from "react";

/** Which side of the target the explanation opens from. */
export type ExplainedAlign = "end" | "start";

/** Whether the explanation opens above the target or below it. */
export type ExplainedSide = "above" | "below";

/**
 * A target small enough that it cannot explain itself, paired with the sentence
 * that does. The target is a focusable button so the explanation is reachable
 * without a pointer, and the sentence repeats in the accessible name because a
 * screen reader never sees the tooltip open.
 *
 * A target that also acts takes `onClick`. One that would act but cannot takes
 * `inert`, which leaves it focusable: the sentence saying why is the whole
 * reason someone lands on it.
 */
export function ExplainedTarget({
  accessibleName,
  align = "start",
  children,
  className,
  inert = false,
  onClick,
  side = "above",
  tooltip,
  wrapperClassName,
  wrapperStyle,
}: {
  readonly accessibleName: string;
  readonly align?: ExplainedAlign;
  readonly children?: ReactNode;
  readonly className: string;
  readonly inert?: boolean;
  readonly onClick?: () => void;
  readonly side?: ExplainedSide;
  readonly tooltip: string;
  readonly wrapperClassName?: string;
  readonly wrapperStyle?: CSSProperties;
}) {
  return (
    <span
      className={
        wrapperClassName === undefined
          ? "diagnostic-label"
          : `diagnostic-label ${wrapperClassName}`
      }
      style={wrapperStyle}
    >
      <button
        aria-disabled={inert || undefined}
        aria-label={accessibleName}
        className={className}
        onClick={inert ? undefined : onClick}
        type="button"
      >
        {children}
      </button>
      <span
        className={`diagnostic-label__tip diagnostic-label__tip--${align} diagnostic-label__tip--${side}`}
        role="tooltip"
      >
        {tooltip}
      </span>
    </span>
  );
}

/** A reading's name, carrying the sentence that explains the reading. */
export const DiagnosticLabel = memo(function DiagnosticLabel({
  align = "start",
  label,
  tooltip,
}: {
  readonly align?: ExplainedAlign;
  readonly label: string;
  readonly tooltip: string;
}) {
  return (
    <ExplainedTarget
      accessibleName={`${label}. ${tooltip}`}
      align={align}
      className="diagnostic-label__name"
      tooltip={tooltip}
    >
      {label}
    </ExplainedTarget>
  );
});
