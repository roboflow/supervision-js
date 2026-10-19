import type { Container, Filter } from "pixi.js";
import { createPixiAnnotationAntialiasFilter } from "./pixi-annotation-antialias";
import {
  PixiSceneLayerKind,
  syncPixiSceneLayerChildren,
  type PixiSceneLayerSlot,
} from "./pixi-scene-layer-slot";

/** Keeps media pixels outside AA while retaining the scene's layer order. */
export function createPixiAnnotationAntialiasLayer(options: {
  readonly Container: new () => Container;
  readonly Filter: Pick<typeof Filter, "from">;
  readonly defaultFilterVert: string;
  readonly getEnabled: () => boolean;
}) {
  const groups: Container[] = [];
  let filter: Filter | undefined;
  let captureResolution = 1;

  return {
    getFxaaFilter(): Filter | null {
      return options.getEnabled() ? ensureFilter() : null;
    },

    setResolution(resolution: number) {
      captureResolution = resolution;
      if (filter) filter.resolution = resolution;
    },
    sync(scene: Container | undefined, slots: readonly PixiSceneLayerSlot[]) {
      if (!scene) return;
      for (const group of groups) {
        group.removeChildren();
        group.filters = null;
      }
      if (!options.getEnabled()) {
        syncPixiSceneLayerChildren(scene, slots);
        return;
      }
      scene.removeChildren();
      let index = 0;
      let group: Container | undefined;
      for (const slot of [...slots].sort(
        (left, right) => left.order - right.order,
      )) {
        const display = slot.getDisplay();
        if (!display) continue;
        if (
          slot.kind === PixiSceneLayerKind.Media ||
          slot.kind === PixiSceneLayerKind.Region ||
          slot.kind === PixiSceneLayerKind.Label
        ) {
          // Regions smooth coverage separately from their copied video.
          // Labels capture backgrounds separately so text stays sharp.
          group = undefined;
          scene.addChild(display);
          continue;
        }
        if (!group) {
          const sharedFilter = ensureFilter();
          group = groups[index] ??= new options.Container();
          index += 1;
          group.filters = [sharedFilter];
          scene.addChild(group);
        }
        group.addChild(display);
      }
    },

    destroy() {
      for (const group of groups) {
        group.filters = null;
        if (!group.parent) group.destroy({ children: false });
      }
      filter?.destroy();
    },
  };

  function ensureFilter() {
    return (filter ??= createPixiAnnotationAntialiasFilter({
      ...options,
      resolution: captureResolution,
    }));
  }
}
