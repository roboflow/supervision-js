import { Container, type Filter } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { createPixiAnnotationAntialiasLayer } from "./pixi-annotation-antialias-layer";
import {
  createPixiSceneLayerSlot,
  PixiSceneLayerKind,
} from "./pixi-scene-layer-slot";

function createFixture() {
  let enabled = false;
  const filter = {
    destroy: vi.fn(),
  } as unknown as Filter;
  const from = vi.fn(() => filter);
  const layer = createPixiAnnotationAntialiasLayer({
    Container,
    Filter: { from },
    defaultFilterVert: "",
    getEnabled: () => enabled,
  });
  const kinds = [
    PixiSceneLayerKind.Media,
    PixiSceneLayerKind.Focus,
    PixiSceneLayerKind.Mask,
    PixiSceneLayerKind.Box,
    PixiSceneLayerKind.Region,
    PixiSceneLayerKind.Interaction,
    PixiSceneLayerKind.Label,
  ];
  const slots = kinds.map((kind) => {
    const slot = createPixiSceneLayerSlot(kind);
    const display = new Container();
    display.label = kind;
    slot.setDisplay(display);
    return slot;
  });
  const scene = new Container();
  return {
    filter,
    from,
    layer,
    scene,
    slots,
    setEnabled(value: boolean) {
      enabled = value;
      layer.sync(scene, slots);
    },
  };
}

describe("annotation AA composition", () => {
  it("keeps default rendering flat and allocates no AA filter", () => {
    const fixture = createFixture();
    fixture.setEnabled(false);
    expect(fixture.scene.children.map((child) => child.label)).toEqual([
      "media",
      "focus",
      "mask",
      "box",
      "region",
      "interaction",
      "label",
    ]);
    expect(fixture.from).not.toHaveBeenCalled();
    fixture.layer.destroy();
    fixture.scene.destroy({ children: true });
  });

  it("smooths annotations on each side of video-copy regions in their draw order", () => {
    const fixture = createFixture();
    fixture.setEnabled(true);
    const [media, before, region, after, labels] = fixture.scene.children;
    expect(media?.label).toBe("media");
    expect(region?.label).toBe("region");
    expect(media?.filters).toBeUndefined();
    expect(region?.filters).toBeUndefined();
    expect(before?.children.map((child) => child.label)).toEqual([
      "focus",
      "mask",
      "box",
    ]);
    expect(after?.children.map((child) => child.label)).toEqual([
      "interaction",
    ]);
    expect(labels?.label).toBe("label");
    expect(labels?.filters).toBeUndefined();
    expect(fixture.layer.getFxaaFilter()).toBe(fixture.filter);
    expect(before?.filters).toEqual([fixture.filter]);
    expect(after?.filters).toEqual([fixture.filter]);
    fixture.layer.destroy();
    expect(before?.filters).toBeNull();
    expect(after?.filters).toBeNull();
    fixture.scene.destroy({ children: true });
  });

  it("reuses groups across quality toggles and returns to the exact flat order", () => {
    const fixture = createFixture();
    fixture.setEnabled(false);
    const off = [...fixture.scene.children];
    fixture.setEnabled(true);
    const groups = [...fixture.scene.children];
    fixture.setEnabled(false);
    expect(fixture.scene.children).toEqual(off);
    fixture.setEnabled(true);
    expect(fixture.scene.children).toEqual(groups);
    expect(fixture.from).toHaveBeenCalledOnce();
    fixture.setEnabled(false);
    fixture.layer.destroy();
    expect(fixture.filter.destroy).toHaveBeenCalledOnce();
    expect(off.every((child) => !child.destroyed)).toBe(true);
    fixture.scene.destroy({ children: true });
  });

  it("shares one lazy FXAA filter with label-only captures", () => {
    const fixture = createFixture();
    fixture.slots.splice(1, fixture.slots.length - 2);
    expect(fixture.layer.getFxaaFilter()).toBeNull();
    expect(fixture.from).not.toHaveBeenCalled();
    fixture.setEnabled(true);
    expect(fixture.from).not.toHaveBeenCalled();
    expect(fixture.layer.getFxaaFilter()).toBe(fixture.filter);
    expect(fixture.layer.getFxaaFilter()).toBe(fixture.filter);
    expect(fixture.from).toHaveBeenCalledOnce();
    fixture.setEnabled(false);
    expect(fixture.layer.getFxaaFilter()).toBeNull();
    fixture.layer.destroy();
    expect(fixture.filter.destroy).toHaveBeenCalledOnce();
    fixture.scene.destroy({ children: true });
  });

  it("tracks resolved capture density without replacing the AA filter or scene", () => {
    const fixture = createFixture();
    fixture.layer.setResolution(3);
    fixture.setEnabled(true);
    expect(fixture.from).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 3 }),
    );
    const children = [...fixture.scene.children];
    fixture.layer.setResolution(8);
    expect(fixture.filter.resolution).toBe(8);
    fixture.layer.setResolution(4);
    expect(fixture.filter.resolution).toBe(4);
    expect(fixture.scene.children).toEqual(children);
    expect(fixture.from).toHaveBeenCalledOnce();
    fixture.layer.destroy();
    fixture.scene.destroy({ children: true });
  });
});
