import { Container, Graphics, Rectangle } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  setPixiViewportBounds,
  syncPixiMaskViewportBounds,
} from "./pixi-mask-viewport";

describe("mask viewport bounds", () => {
  it.each([1, -1])(
    "clips rotated coverage without changing its transform (mirror %s)",
    (mirror) => {
      const container = new Container();
      const geometry = new Graphics().rect(-100, -10, 200, 20).fill(0xffffff);
      container.addChild(geometry);
      geometry.position.set(70, 25);
      geometry.scale.set(2 * mirror, 3);
      geometry.rotation = Math.PI / 6;
      const viewport = { x: 40, y: 10, width: 50, height: 30 };

      syncPixiMaskViewportBounds(container, viewport, Rectangle);
      expect(container.boundsArea).toEqual(new Rectangle(40, 10, 50, 30));
      expect(geometry.position).toMatchObject({ x: 70, y: 25 });
      expect(geometry.scale).toMatchObject({ x: 2 * mirror, y: 3 });
      expect(geometry.rotation).toBe(Math.PI / 6);

      container.scale.set(8);
      container.position.set(-320, -80);
      const bounds = container.getBounds();
      expect(bounds).toMatchObject({ minX: 0, minY: 0, maxX: 400, maxY: 240 });
      container.destroy({ children: true });
    },
  );

  it("keeps small mask targets tight and updates after camera pan or direct translation", () => {
    const container = new Container();
    const geometry = new Graphics().rect(0, 0, 20, 10).fill(0xffffff);
    container.addChild(geometry);
    geometry.position.set(10, 10);
    syncPixiMaskViewportBounds(
      container,
      { x: 0, y: 0, width: 100, height: 100 },
      Rectangle,
    );
    expect(container.boundsArea).toEqual(new Rectangle(10, 10, 20, 10));

    syncPixiMaskViewportBounds(
      container,
      { x: 20, y: 15, width: 100, height: 100 },
      Rectangle,
    );
    expect(container.boundsArea).toEqual(new Rectangle(20, 15, 10, 5));
    geometry.position.set(35, 20);
    syncPixiMaskViewportBounds(
      container,
      { x: 20, y: 15, width: 100, height: 100 },
      Rectangle,
    );
    expect(container.boundsArea).toEqual(new Rectangle(35, 20, 20, 10));
    container.destroy({ children: true });
  });

  it("retains an empty intersection for offscreen masks and releases clipping without a viewport", () => {
    const container = new Container();
    container.addChild(new Graphics().rect(-40, -20, 10, 10).fill(0xffffff));
    syncPixiMaskViewportBounds(
      container,
      { x: 0, y: 0, width: 100, height: 100 },
      Rectangle,
    );
    expect(container.boundsArea.width).toBe(0);
    expect(container.boundsArea.height).toBe(0);
    syncPixiMaskViewportBounds(container, undefined, Rectangle);
    expect(container.boundsArea).toBeUndefined();
    expect(container.getBounds()).toMatchObject({
      minX: -40,
      maxX: -30,
      minY: -20,
      maxY: -10,
    });
    container.destroy({ children: true });
  });

  it("intersects inverse dim bounds with both the media and visible canvas", () => {
    const dim: { boundsArea?: Rectangle } = {};
    setPixiViewportBounds(
      dim,
      { x: 0, y: 0, width: 200, height: 100 },
      { x: -10, y: 20, width: 80, height: 100 },
      Rectangle,
    );
    expect(dim.boundsArea).toEqual(new Rectangle(0, 20, 70, 80));
  });
});
