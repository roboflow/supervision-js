import {
  memo,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { DemoEvalHook } from "../eval-hooks";

/**
 * React rewrites an input's `name` and `type` attributes on every commit that
 * touches it, whether or not its value moved. The scrub input is therefore its
 * own memoized element with primitive props and stable handlers, and its value
 * is written through the ref by whoever is tracking the playhead: a playing
 * player never commits here at all.
 */
export const TimelineScrubInput = memo(function TimelineScrubInput({
  disabled,
  inputRef,
  max,
  onBlur,
  onChange,
  onKeyUp,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onPointerUp,
}: {
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly max: number;
  readonly onBlur: () => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onKeyUp: () => void;
  readonly onPointerDown: () => void;
  readonly onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
}) {
  return (
    <input
      aria-label="Timeline"
      className="timeline-view__input"
      data-eval={DemoEvalHook.TimelineInput}
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
      ref={inputRef}
      step={0.01}
      type="range"
    />
  );
});
