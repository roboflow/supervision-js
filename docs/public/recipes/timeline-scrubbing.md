---
title: Timeline Scrubbing
group: Recipes
summary: Drive indexed timeline gestures with latest-wins navigation.
---

# Timeline Scrubbing

Use `frameNavigation` for indexed sources. It handles latest-wins scrubbing and
exact landing without a host debounce or timeout. This installer accepts your
UI's pointer-to-time and key-to-time mappings; return `null` when the source
lacks indexed capabilities and keep your time-based controls as a fallback.
The timeline must be focusable and use `touch-action: none` for touch dragging.

```ts
import type { LiveMediaSession } from "supervision";

export function installTimelineScrubber(
  session: LiveMediaSession,
  timeline: HTMLElement,
  secondsForPointer: (event: PointerEvent) => number,
  secondsForKey: (event: KeyboardEvent) => number,
  showUnsupported: () => void,
) {
  const clock = session.frameClock;
  const navigation = session.frameNavigation;
  if (!clock || !navigation) {
    showUnsupported();
    return null;
  }
  let gesture = 0;
  let active: number | "keyboard" | null = null;
  let disposed = false;
  let lastTarget = clock.timeAt(0);
  let pendingTarget: number | null = null;
  const report = (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error(error);
  };
  const finish = () => {
    if (active === null) return;
    const pointer = active;
    active = null;
    if (typeof pointer === "number" && timeline.hasPointerCapture(pointer)) {
      timeline.releasePointerCapture(pointer);
    }
    const finishingGesture = gesture;
    void navigation
      .moveToTime(lastTarget)
      .catch(report)
      .finally(() => {
        if (!disposed && finishingGesture === gesture) {
          pendingTarget = null;
        }
      });
  };
  const preview = (seconds: number) => {
    lastTarget = seconds;
    const scrub = navigation.scrubToTime(lastTarget);
    pendingTarget = scrub.target.mediaTime;
    void scrub.settled.catch(report);
  };
  const move = (event: PointerEvent) => {
    if (active === event.pointerId) preview(secondsForPointer(event));
  };
  const begin = (event: PointerEvent) => {
    if (active !== null || event.button !== 0) return;
    event.preventDefault();
    timeline.focus();
    active = event.pointerId;
    gesture += 1;
    timeline.setPointerCapture(event.pointerId);
    move(event);
  };
  const end = (event: PointerEvent) => {
    if (active !== event.pointerId) return;
    if (event.type === "pointerup") move(event);
    finish();
  };
  const movementKeys = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);
  const key = (event: KeyboardEvent) => {
    if (typeof active === "number") return;
    if (movementKeys.has(event.key)) {
      event.preventDefault();
      if (active === null) {
        active = "keyboard";
        gesture += 1;
      }
      preview(secondsForKey(event));
    } else if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  };
  const keyEnd = (event: KeyboardEvent) => {
    if (active === "keyboard" && movementKeys.has(event.key)) finish();
  };
  timeline.addEventListener("pointerdown", begin);
  timeline.addEventListener("pointermove", move);
  timeline.addEventListener("pointerup", end);
  timeline.addEventListener("pointercancel", end);
  timeline.addEventListener("lostpointercapture", end);
  timeline.addEventListener("keydown", key);
  timeline.addEventListener("keyup", keyEnd);
  timeline.addEventListener("blur", finish);
  return {
    knobTime: () =>
      pendingTarget ?? session.getState().renderer?.presentedTime ?? 0,
    destroy() {
      finish();
      disposed = true;
      gesture += 1;
      pendingTarget = null;
      timeline.removeEventListener("pointerdown", begin);
      timeline.removeEventListener("pointermove", move);
      timeline.removeEventListener("pointerup", end);
      timeline.removeEventListener("pointercancel", end);
      timeline.removeEventListener("lostpointercapture", end);
      timeline.removeEventListener("keydown", key);
      timeline.removeEventListener("keyup", keyEnd);
      timeline.removeEventListener("blur", finish);
    },
  };
}
```

Pointer-up, cancellation, lost capture, keyboard release, Enter, Escape, and
focus loss all commit the last target once. Cancellation commits the position
already previewed; it does not restore the gesture's starting position. The
pending target remains the knob value until the exact move settles, and an old
completion cannot clear a newer gesture. Call `destroy()` when removing the
control, before destroying its session.

For exact frame steps, see [Exact Frame Navigation](../guides/media-sessions.md#exact-frame-navigation).
The [local demo](../../../CONTRIBUTING.md) provides a runnable timeline; start
it with `npm run dev` from the repository checkout.
