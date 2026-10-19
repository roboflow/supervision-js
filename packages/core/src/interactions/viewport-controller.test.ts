import { describe, expect, it, vi } from "vitest";
import { createViewportController } from "./viewport-controller";

describe("viewport controller", () => {
  it("keeps the media point under the cursor fixed while zooming", () => {
    const listener = vi.fn();
    const viewport = createViewportController({ scale: 1, x: 10, y: 20 });
    viewport.subscribe(listener);
    const cursor = { x: 110, y: 220 };
    const before = viewport.screenToMedia(cursor);
    viewport.zoomAt(cursor, 2);
    expect(viewport.screenToMedia(cursor)).toEqual(before);
    expect(viewport.getTransform()).toMatchObject({
      scale: 2,
      x: -90,
      y: -180,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("clamps wheel zoom and honors locking", () => {
    const viewport = createViewportController({ scale: 1 });
    viewport.zoomFromWheel({ x: 0, y: 0 }, -10_000);
    expect(viewport.getTransform().scale).toBeCloseTo(Math.exp(0.5));
    viewport.setLocked(true);
    viewport.panBy(10, 10);
    expect(viewport.getTransform()).toMatchObject({ locked: true, x: 0, y: 0 });
  });
  it.each([0.025, 30])(
    "restores exact scale %s while locked, then zooms gradually toward gesture bounds",
    (scale) => {
      const viewport = createViewportController();
      viewport.setLocked(true);
      viewport.setTransform({ scale, x: -42, y: 77 });
      expect(viewport.getTransform()).toEqual({
        locked: true,
        scale,
        x: -42,
        y: 77,
      });
      viewport.zoomAt({ x: 100, y: 100 }, 2);
      expect(viewport.getTransform().scale).toBe(scale);
      viewport.setLocked(false);
      const anchor = viewport.screenToMedia({ x: 100, y: 100 });
      viewport.zoomAt({ x: 100, y: 100 }, scale < 0.1 ? 2 : 0.5);
      expect(viewport.getTransform().scale).toBe(
        scale < 0.1 ? scale * 2 : scale * 0.5,
      );
      expect(viewport.screenToMedia({ x: 100, y: 100 })).toEqual(anchor);
    },
  );
});
