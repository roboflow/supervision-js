import type { MaskBrushEditor } from "#editing/mask-brush-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPixiMaskBrushPreview } from "./pixi-mask-brush-preview";

describe("Pixi mask brush preview", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])("draws synchronously (notify: %s)", async (notify) => {
    const queueMicrotask = vi.spyOn(globalThis, "queueMicrotask");
    let textureListener: (() => void) | null = null;
    let cursorListener: (() => void) | null = null;
    const sourceUpdate = vi.fn();
    const textureUpdate = vi.fn();
    const cursorClear = vi.fn();
    const onInvalidate = vi.fn();
    const editor = {
      canvas: { height: 40, width: 60 },
      getCursor: () => ({ mode: "add", point: { x: 4, y: 5 }, radius: 3 }),
      subscribeCursorUpdates(listener: () => void) {
        cursorListener = listener;
        return () => {
          cursorListener = null;
        };
      },
      subscribeTextureUpdates(listener: () => void) {
        textureListener = listener;
        return () => {
          textureListener = null;
        };
      },
    } as unknown as MaskBrushEditor;

    class Source {
      destroy = vi.fn();
      update = sourceUpdate;
    }
    class Texture {
      destroy = vi.fn();
      update = textureUpdate;
    }
    class Sprite {
      alpha = 1;
      height = 0;
      tint = 0;
      width = 0;
    }
    class Graphics {
      circle = vi.fn();
      clear = cursorClear;
      stroke = vi.fn();
    }
    class Container {
      addChild = vi.fn();
    }

    const preview = createPixiMaskBrushPreview({
      CanvasSource: Source as never,
      Container: Container as never,
      Graphics: Graphics as never,
      Sprite: Sprite as never,
      Texture: Texture as never,
      preview: { editor },
      onInvalidate: notify ? onInvalidate : undefined,
    });

    expect(cursorClear).toHaveBeenCalledTimes(1);
    expect(onInvalidate).not.toHaveBeenCalled();
    cursorListener!();
    expect(cursorClear).toHaveBeenCalledTimes(2);
    expect(sourceUpdate).not.toHaveBeenCalled();
    expect(onInvalidate).not.toHaveBeenCalled();

    textureListener!();
    expect(sourceUpdate).toHaveBeenCalledTimes(1);
    expect(textureUpdate).not.toHaveBeenCalled();
    expect(cursorClear).toHaveBeenCalledTimes(2);
    expect(onInvalidate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onInvalidate).toHaveBeenCalledTimes(notify ? 1 : 0);

    preview.setViewportScale(2);
    await Promise.resolve();
    expect(onInvalidate).toHaveBeenCalledTimes(notify ? 1 : 0);

    cursorListener!();
    preview.destroy();
    await Promise.resolve();
    expect(onInvalidate).toHaveBeenCalledTimes(notify ? 1 : 0);
    expect(textureListener).toBeNull();
    expect(cursorListener).toBeNull();
    if (!notify) expect(queueMicrotask).not.toHaveBeenCalled();
  });
});
