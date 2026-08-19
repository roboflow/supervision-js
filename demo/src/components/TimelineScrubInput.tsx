import {
  memo,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * React rewrites an input's `name` and `type` attributes on every commit that
 * touches it, whether or not its value moved. The scrub input is therefore its
 * own memoized element with primitive props and stable handlers: a paused
 * player re-renders the panel around it without mutating the DOM here.
 */
export const TimelineScrubInput = memo(function TimelineScrubInput({
  disabled,
  max,
  onBlur,
  onChange,
  onKeyUp,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onPointerUp,
  value,
}: {
  readonly disabled: boolean;
  readonly max: number;
  readonly onBlur: () => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onKeyUp: () => void;
  readonly onPointerDown: () => void;
  readonly onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly value: number;
}) {
  return (
    <input
      aria-label="Timeline"
      className="timeline-view__input"
      disabled={disabled}
      max={max}
      min={0}
      onBlur={onBlur}
      onChange={onChange}
      onKeyUp={onKeyUp}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      step={0.01}
      type="range"
      value={value}
    />
  );
});
