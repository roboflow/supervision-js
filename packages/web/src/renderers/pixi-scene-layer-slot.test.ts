import { describe, expect, it } from "vitest";

import {
  createPixiSceneLayerSlot,
  PixiSceneLayerKind,
  syncPixiSceneLayerChildren,
} from "./pixi-scene-layer-slot";

describe("pixi scene layer slots", () => {
  it("syncs scene children in canonical layer order", () => {
    const scene = new FakeContainer();
    const mediaSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Media);
    const maskSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Mask);
    const boxSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Box);
    const interactionSlot = createPixiSceneLayerSlot(
      PixiSceneLayerKind.Interaction,
    );
    const labelSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Label);
    const media = new FakeDisplay("media");
    const mask = new FakeDisplay("mask");
    const box = new FakeDisplay("box");
    const interaction = new FakeDisplay("interaction");
    const label = new FakeDisplay("label");
    const slots = [mediaSlot, maskSlot, boxSlot, interactionSlot, labelSlot];

    labelSlot.setDisplay(label as never);
    boxSlot.setDisplay(box as never);
    mediaSlot.setDisplay(media as never);
    syncPixiSceneLayerChildren(scene as never, slots);

    expect(scene.children.map((child) => child.name)).toEqual([
      "media",
      "box",
      "label",
    ]);

    maskSlot.setDisplay(mask as never);
    interactionSlot.setDisplay(interaction as never);
    syncPixiSceneLayerChildren(scene as never, slots);

    expect(scene.children.map((child) => child.name)).toEqual([
      "media",
      "mask",
      "box",
      "interaction",
      "label",
    ]);

    maskSlot.setDisplay(undefined);
    syncPixiSceneLayerChildren(scene as never, slots);

    expect(scene.children.map((child) => child.name)).toEqual([
      "media",
      "box",
      "interaction",
      "label",
    ]);
  });
});

class FakeContainer {
  readonly children: FakeDisplay[] = [];

  addChild(...children: FakeDisplay[]) {
    this.children.push(...children);
  }

  removeChildren() {
    return this.children.splice(0);
  }
}

class FakeDisplay {
  constructor(readonly name: string) {}
}
