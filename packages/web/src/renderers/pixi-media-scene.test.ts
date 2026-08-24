import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canReuseMaskVisibilityArtifacts,
  observePixiContainerResize,
} from "./pixi-media-scene";
import {
  createPixiSceneLayerSlot,
  PixiSceneLayerKind,
  syncPixiSceneLayerChildren,
} from "./pixi-scene-layer-slot";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pixi media scene container resizing", () => {
  it("synchronously resizes Pixi when the host element changes size", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let notify: ResizeObserverCallback = () => undefined;

    class TestResizeObserver {
      public constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }

      public observe = observe;
      public unobserve = vi.fn();
      public disconnect = disconnect;
    }

    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const container = {} as HTMLElement;
    const resize = vi.fn();

    const stopObserving = observePixiContainerResize(container, resize);

    expect(observe).toHaveBeenCalledWith(container);
    notify([], {} as ResizeObserver);
    expect(resize).toHaveBeenCalledTimes(1);

    stopObserving();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("is a no-op where ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const resize = vi.fn();

    const stopObserving = observePixiContainerResize({} as HTMLElement, resize);

    expect(() => stopObserving()).not.toThrow();
    expect(resize).not.toHaveBeenCalled();
  });
});

describe("Pixi media scene mask visibility", () => {
  it("reuses mask artifacts across equivalent visibility objects", () => {
    expect(
      canReuseMaskVisibilityArtifacts(
        {
          ephemeralDetectionIds: new Set(["preview"]),
          hiddenClasses: ["car"],
          hiddenDetectionIds: new Set(["hidden"]),
          loadingDetectionIds: ["loading"],
        },
        {
          ephemeralDetectionIds: ["preview"],
          hiddenClasses: new Set(["car"]),
          hiddenDetectionIds: ["hidden"],
          loadingDetectionIds: new Set(["loading"]),
        },
      ),
    ).toBe(true);
  });

  it("ignores label-only visibility changes for mask artifacts", () => {
    expect(
      canReuseMaskVisibilityArtifacts(
        { labelsHidden: false },
        { labelsHidden: true },
      ),
    ).toBe(true);
  });

  it.each([
    [{}, { annotationsHidden: true }],
    [{}, { creatingDetectionId: "draft" }],
    [{}, { ephemeralDetectionIds: ["preview"] }],
    [{}, { hiddenClasses: ["car"] }],
    [{}, { hiddenDetectionIds: ["hidden"] }],
    [{}, { loadingDetectionIds: ["loading"] }],
  ])(
    "invalidates mask artifacts when mask visibility changes",
    (previous, next) => {
      expect(canReuseMaskVisibilityArtifacts(previous, next)).toBe(false);
    },
  );
});

describe("Pixi media scene layer stacking", () => {
  it("stacks the focus veil under the interaction affordances, whatever order they arrive in", () => {
    const scene = { children: [] as { name: string }[] };
    const focusSlot = createPixiSceneLayerSlot(PixiSceneLayerKind.Focus);
    const interactionSlot = createPixiSceneLayerSlot(
      PixiSceneLayerKind.Interaction,
    );
    const slots = [interactionSlot, focusSlot];
    const container = {
      addChild: (...children: { name: string }[]) => {
        scene.children.push(...children);
      },
      removeChildren: () => scene.children.splice(0),
    };

    interactionSlot.setDisplay({ name: "interaction" } as never);
    focusSlot.setDisplay({ name: "focus" } as never);
    syncPixiSceneLayerChildren(container as never, slots);

    expect(scene.children.map(({ name }) => name)).toStrictEqual([
      "focus",
      "interaction",
    ]);
  });
});
