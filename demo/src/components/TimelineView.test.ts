import { createElement, type ChangeEvent, type PointerEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const inputBoundaryCapture = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./TimelineScrubInput", () => ({
  TimelineScrubInput: (props: unknown) => {
    inputBoundaryCapture.current = props;
    return null;
  },
}));

import {
  resolveTimelineTime,
  settlePendingTimelineSeek,
  TimelineView,
} from "./TimelineView";

interface TimelineInputBoundary {
  onChange(event: ChangeEvent<HTMLInputElement>): void;
  onLostPointerCapture(event: PointerEvent<HTMLInputElement>): void;
  onPointerDown(event: PointerEvent<HTMLInputElement>): void;
  onPointerMove(event: PointerEvent<HTMLInputElement>): void;
  onPointerUp(event: PointerEvent<HTMLInputElement>): void;
}

function renderTimelineInput({
  onScrub,
  onSeek,
}: {
  onScrub: (time: number) => void;
  onSeek: (time: number) => Promise<void> | void;
}) {
  inputBoundaryCapture.current = null;
  renderToStaticMarkup(
    createElement(TimelineView, {
      disabled: false,
      duration: 100,
      onScrub,
      onSeek,
    }),
  );

  if (inputBoundaryCapture.current === null) {
    throw new Error("TimelineView did not render its scrub input");
  }

  return inputBoundaryCapture.current as TimelineInputBoundary;
}

function inputElement() {
  return {
    getBoundingClientRect: () => ({ left: 10, width: 100 }),
    setPointerCapture: vi.fn(),
  } as unknown as HTMLInputElement;
}

function pointerEvent(
  currentTarget: HTMLInputElement,
  clientX: number,
  buttons: number,
) {
  return {
    buttons,
    clientX,
    currentTarget,
    pointerId: 7,
  } as PointerEvent<HTMLInputElement>;
}

function changeEvent(value: number) {
  return {
    currentTarget: { value: String(value) },
  } as ChangeEvent<HTMLInputElement>;
}

describe("TimelineView range input gestures", () => {
  it("commits a quick click once and ignores the native change that follows pointerup", () => {
    const onScrub = vi.fn();
    const onSeek = vi.fn();
    const input = renderTimelineInput({ onScrub, onSeek });
    const element = inputElement();

    input.onPointerDown(pointerEvent(element, 82, 1));
    input.onPointerUp(pointerEvent(element, 82, 0));
    input.onLostPointerCapture(pointerEvent(element, 82, 0));
    input.onChange(changeEvent(72));

    expect(element.setPointerCapture).toHaveBeenCalledOnce();
    expect(onScrub).not.toHaveBeenCalled();
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledWith(72);
  });

  it("does not swallow a later assistive change when no native change followed pointerup", () => {
    const onScrub = vi.fn();
    const input = renderTimelineInput({ onScrub, onSeek: vi.fn() });
    const element = inputElement();

    input.onPointerDown(pointerEvent(element, 82, 1));
    input.onPointerUp(pointerEvent(element, 82, 0));
    input.onChange(changeEvent(12));

    expect(onScrub).toHaveBeenCalledOnce();
    expect(onScrub).toHaveBeenCalledWith(12);
  });

  it("publishes each new drag position and commits only the terminal one", () => {
    const onScrub = vi.fn();
    const onSeek = vi.fn();
    const input = renderTimelineInput({ onScrub, onSeek });
    const element = inputElement();

    input.onPointerDown(pointerEvent(element, 25, 1));
    input.onPointerMove(pointerEvent(element, 45, 1));
    input.onPointerMove(pointerEvent(element, 45, 1));
    input.onPointerUp(pointerEvent(element, 78, 0));
    input.onChange(changeEvent(68));

    expect(onScrub.mock.calls).toEqual([[35], [68]]);
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledWith(68);
  });
});

describe("resolveTimelineTime", () => {
  it("follows the drag while a pointer is down", () => {
    expect(resolveTimelineTime(34.46, null, 0)).toBe(34.46);
  });

  it("stays on a committed seek's target while its picture is still coming", () => {
    // The player keeps reporting the frame on screen through a seek, so falling
    // back to it walks the playhead back to where the viewer started. On a slow
    // source that is most of the wait.
    expect(resolveTimelineTime(null, 34.46, 0)).toBe(34.46);
  });

  it("follows the player once nothing is outstanding", () => {
    expect(resolveTimelineTime(null, null, 12.5)).toBe(12.5);
  });

  it("prefers a new drag over a seek still in flight", () => {
    expect(resolveTimelineTime(58, 34.46, 0)).toBe(58);
  });

  it("reports nothing when the player has not said where it is", () => {
    expect(resolveTimelineTime(null, null, null)).toBe(null);
  });

  it("keeps a target of zero, which is a position and not an absence", () => {
    expect(resolveTimelineTime(null, 0, 47.3)).toBe(0);
  });
});

describe("settlePendingTimelineSeek", () => {
  it("clears the target only when its own seek finishes", () => {
    expect(
      settlePendingTimelineSeek({ runId: 4, target: 34.46 }, 4),
    ).toBeNull();
  });

  it("keeps the second rapid click when its predecessor finishes first", () => {
    const firstClick = { runId: 4, target: 12 };
    const secondClick = { runId: 5, target: 58 };
    const pending = settlePendingTimelineSeek(secondClick, firstClick.runId);

    expect(pending).not.toBeNull();
    if (pending === null) throw new Error("the newer click was cleared");
    expect(pending).toBe(secondClick);
    expect(resolveTimelineTime(null, pending.target, 12)).toBe(58);
    expect(settlePendingTimelineSeek(pending, secondClick.runId)).toBeNull();
  });
});
