import type { Container as PixiContainer } from "pixi.js";

export enum PixiSceneLayerKind {
  Media = "media",
  Mask = "mask",
  Box = "box",
  Interaction = "interaction",
  Label = "label",
}

export interface PixiSceneLayerSlot {
  readonly kind: PixiSceneLayerKind;
  getDisplay(): PixiContainer | undefined;
  setDisplay(display: PixiContainer | undefined): void;
}

export function createPixiSceneLayerSlot(
  kind: PixiSceneLayerKind,
): PixiSceneLayerSlot {
  let display: PixiContainer | undefined;

  return {
    getDisplay() {
      return display;
    },

    kind,

    setDisplay(nextDisplay) {
      display = nextDisplay;
    },
  };
}

export function syncPixiSceneLayerChildren(
  scene: PixiContainer | undefined,
  slots: readonly PixiSceneLayerSlot[],
) {
  if (!scene) {
    return;
  }

  const displays = slots
    .map((slot) => slot.getDisplay())
    .filter((display): display is PixiContainer => display !== undefined);

  clearSceneChildren(scene);

  if (displays.length === 0) {
    return;
  }

  scene.addChild(...displays);
}

function clearSceneChildren(scene: PixiContainer) {
  if (typeof scene.removeChildren === "function") {
    scene.removeChildren();
    return;
  }

  const fakeScene = scene as { children?: unknown[] };

  if (Array.isArray(fakeScene.children)) {
    fakeScene.children.splice(0);
  }
}
