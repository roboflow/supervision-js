import type { Container as PixiContainer } from "pixi.js";

export enum PixiSceneLayerKind {
  Media = "media",
  Mask = "mask",
  Box = "box",
  Vector = "vector",
  Focus = "focus",
  Preview = "preview",
  Guide = "guide",
  Handle = "handle",
  Interaction = "interaction",
  Label = "label",
}

export interface PixiSceneLayerSlot {
  /** Open identifier: hosts may register their own layer kinds. */
  readonly kind: string;
  readonly order: number;
  getDisplay(): PixiContainer | undefined;
  setDisplay(display: PixiContainer | undefined): void;
}

export function createPixiSceneLayerSlot(
  kind: string,
  order = defaultLayerOrder(kind),
): PixiSceneLayerSlot {
  let display: PixiContainer | undefined;

  return {
    getDisplay() {
      return display;
    },

    kind,
    order,

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

  const displays = [...slots]
    .sort((left, right) => left.order - right.order)
    .map((slot) => slot.getDisplay())
    .filter((display): display is PixiContainer => display !== undefined);

  clearSceneChildren(scene);

  if (displays.length === 0) {
    return;
  }

  scene.addChild(...displays);
}

function defaultLayerOrder(kind: string) {
  switch (kind) {
    case PixiSceneLayerKind.Media:
      return 0;
    case PixiSceneLayerKind.Mask:
      return 100;
    case PixiSceneLayerKind.Box:
      return 200;
    case PixiSceneLayerKind.Vector:
      return 250;
    case PixiSceneLayerKind.Focus:
      return 300;
    case PixiSceneLayerKind.Preview:
      return 400;
    case PixiSceneLayerKind.Guide:
      return 500;
    case PixiSceneLayerKind.Handle:
      return 750;
    case PixiSceneLayerKind.Interaction:
      return 700;
    case PixiSceneLayerKind.Label:
      return 800;
    default:
      return 350;
  }
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
