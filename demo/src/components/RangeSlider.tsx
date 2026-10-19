import {
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { roundToStep } from "../depth";
import "./range-slider.css";

export interface SliderRange {
  readonly min: number;
  readonly max: number;
}

export type RangeThumb = "min" | "max";

/**
 * Puts one thumb at `to`, on the step and inside the bounds. The thumbs stay
 * a step apart, so the low one never passes the high one.
 */
export function moveRangeThumb(
  range: SliderRange,
  thumb: RangeThumb,
  to: number,
  bounds: SliderRange,
  step: number,
): SliderRange {
  const snapped = roundToStep(to, step);

  return thumb === "min"
    ? {
        max: range.max,
        min: Math.max(
          bounds.min,
          Math.min(snapped, roundToStep(range.max - step, step)),
        ),
      }
    : {
        max: Math.min(
          bounds.max,
          Math.max(snapped, roundToStep(range.min + step, step)),
        ),
        min: range.min,
      };
}

/** Where a key sends a thumb, or null for a key the slider leaves alone. */
export function rangeKeyTarget(
  key: string,
  coarse: boolean,
  at: number,
  bounds: SliderRange,
  step: number,
): number | null {
  const stride = coarse ? step * 10 : step;

  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return at - stride;
    case "ArrowRight":
    case "ArrowUp":
      return at + stride;
    case "PageDown":
      return at - step * 10;
    case "PageUp":
      return at + step * 10;
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}

export function nearestRangeThumb(range: SliderRange, at: number): RangeThumb {
  return Math.abs(at - range.min) <= Math.abs(at - range.max) && at <= range.max
    ? "min"
    : "max";
}

/**
 * Two thumbs on one track. `colors` paint the values between the thumbs from
 * low to high, and each end colour carries on past its thumb, which is how
 * a renderer colours values outside the range.
 */
export function RangeSlider({
  bounds,
  colors,
  disabled = false,
  format,
  labels,
  onChange,
  step,
  value,
}: {
  readonly bounds: SliderRange;
  readonly colors: readonly string[];
  readonly disabled?: boolean;
  readonly format: (value: number) => string;
  readonly labels: { readonly min: string; readonly max: string };
  readonly onChange: (value: SliderRange) => void;
  readonly step: number;
  readonly value: SliderRange;
}): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRefs = {
    max: useRef<HTMLDivElement>(null),
    min: useRef<HTMLDivElement>(null),
  };
  const dragRef = useRef<RangeThumb | null>(null);
  const span = bounds.max - bounds.min || 1;
  const percent = (at: number) =>
    Math.min(100, Math.max(0, ((at - bounds.min) / span) * 100));
  const low = percent(value.min);
  const high = percent(value.max);
  const stops = colors.map(
    (color, index) =>
      `${color} ${low + ((high - low) * index) / Math.max(1, colors.length - 1)}%`,
  );

  const move = (thumb: RangeThumb, to: number) => {
    const next = moveRangeThumb(value, thumb, to, bounds, step);
    if (next.min !== value.min || next.max !== value.max) onChange(next);
  };
  const valueAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect && rect.width > 0
      ? bounds.min + ((clientX - rect.left) / rect.width) * span
      : null;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const at = valueAt(event.clientX);
    if (at === null) return;
    const grabbed = (event.target as HTMLElement).dataset.thumb;
    const thumb =
      grabbed === "min" || grabbed === "max"
        ? grabbed
        : nearestRangeThumb(value, at);

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = thumb;
    thumbRefs[thumb].current?.focus();
    if (grabbed === undefined) move(thumb, at);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const thumb = dragRef.current;
    const at = thumb ? valueAt(event.clientX) : null;
    if (thumb && at !== null) move(thumb, at);
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const thumbFor = (thumb: RangeThumb) => {
    const at = value[thumb];
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const to = rangeKeyTarget(event.key, event.shiftKey, at, bounds, step);
      if (to === null) return;
      event.preventDefault();
      move(thumb, to);
    };

    return (
      <div
        aria-disabled={disabled || undefined}
        aria-label={labels[thumb]}
        aria-orientation="horizontal"
        aria-valuemax={thumb === "min" ? value.max : bounds.max}
        aria-valuemin={thumb === "min" ? bounds.min : value.min}
        aria-valuenow={at}
        aria-valuetext={format(at)}
        className="range-slider__thumb"
        data-thumb={thumb}
        onKeyDown={onKeyDown}
        ref={thumbRefs[thumb]}
        role="slider"
        style={{ left: `${percent(at)}%` }}
        tabIndex={disabled ? -1 : 0}
      />
    );
  };

  return (
    <div
      className="range-slider"
      data-disabled={disabled || undefined}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    >
      <div className="range-slider__rail" ref={trackRef}>
        <span
          aria-hidden="true"
          className="range-slider__paint"
          style={{
            background: `linear-gradient(to right, ${colors[0]} 0%, ${stops.join(", ")}, ${colors[colors.length - 1]} 100%)`,
          }}
        />
        <span
          aria-hidden="true"
          className="range-slider__shade range-slider__shade--low"
          style={{ left: 0, width: `${low}%` }}
        />
        <span
          aria-hidden="true"
          className="range-slider__shade range-slider__shade--high"
          style={{ left: `${high}%`, right: 0 }}
        />
        {thumbFor("min")}
        {thumbFor("max")}
      </div>
    </div>
  );
}
