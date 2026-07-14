import type { Point } from "#types/detections";
import type { ViewportController, ViewportTransform } from "#types/viewport";

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const MAX_WHEEL_DELTA = 50;

export function createViewportController(
  initial: Partial<ViewportTransform> = {},
): ViewportController {
  let transform: ViewportTransform = freeze({
    locked: initial.locked ?? false,
    scale: clampScale(initial.scale ?? 0.8),
    x: initial.x ?? 0,
    y: initial.y ?? 0,
  });
  const listeners = new Set<(transform: ViewportTransform) => void>();

  const update = (next: ViewportTransform) => {
    if (
      next.scale === transform.scale &&
      next.x === transform.x &&
      next.y === transform.y &&
      next.locked === transform.locked
    )
      return;
    transform = freeze(next);
    for (const listener of listeners) listener(transform);
  };

  const controller: ViewportController = {
    getTransform: () => transform,
    screenToMedia: (point) => screenToMedia(point, transform),
    mediaToScreen: (point) => mediaToScreen(point, transform),
    setTransform(next) {
      if (transform.locked) return;
      update({
        ...transform,
        ...(next.scale === undefined ? {} : { scale: clampScale(next.scale) }),
        ...(next.x === undefined ? {} : { x: next.x }),
        ...(next.y === undefined ? {} : { y: next.y }),
      });
    },
    setLocked(locked) {
      update({ ...transform, locked });
    },
    panBy(dx, dy) {
      if (transform.locked) return;
      update({ ...transform, x: transform.x + dx, y: transform.y + dy });
    },
    zoomAt(point, factor) {
      if (transform.locked || !Number.isFinite(factor) || factor <= 0) return;
      const mediaPoint = screenToMedia(point, transform);
      const scale = clampScale(transform.scale * factor);
      update({
        ...transform,
        scale,
        x: point.x - mediaPoint.x * scale,
        y: point.y - mediaPoint.y * scale,
      });
    },
    zoomFromWheel(point, deltaY) {
      const delta = Math.max(
        -MAX_WHEEL_DELTA,
        Math.min(MAX_WHEEL_DELTA, deltaY),
      );
      controller.zoomAt(point, Math.exp(-delta * 0.01));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return controller;
}

export function screenToMedia(
  point: Point,
  transform: ViewportTransform,
): Point {
  return {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  };
}

export function mediaToScreen(
  point: Point,
  transform: ViewportTransform,
): Point {
  return {
    x: point.x * transform.scale + transform.x,
    y: point.y * transform.scale + transform.y,
  };
}

function clampScale(scale: number) {
  return Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, Number.isFinite(scale) ? scale : 1),
  );
}

function freeze(transform: ViewportTransform) {
  return Object.freeze(transform);
}
