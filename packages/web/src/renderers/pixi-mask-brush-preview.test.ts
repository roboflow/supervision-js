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

  it("uploads a fitted copy of a brush canvas over the texture limit", () => {
    let textureListener: (() => void) | null = null;
    const drawImage = vi.fn();
    const brushCanvas = { height: 1200, width: 8000 };
    const uploadCanvas = {
      getContext: () => ({ clearRect: vi.fn(), drawImage }),
      height: 0,
      width: 0,
    };
    const editor = {
      canvas: brushCanvas,
      getCursor: () => ({ mode: "add", point: null, radius: 3 }),
      subscribeCursorUpdates: () => () => undefined,
      subscribeTextureUpdates(listener: () => void) {
        textureListener = listener;
        return () => undefined;
      },
    } as unknown as MaskBrushEditor;
    const sources: Array<{ resource: unknown; width: number; height: number }> =
      [];
    const sprites: Array<{ width: number; height: number }> = [];

    createPixiMaskBrushPreview({
      CanvasSource: class {
        destroy = vi.fn();
        update = vi.fn();
        constructor(options: {
          resource: unknown;
          width: number;
          height: number;
        }) {
          sources.push(options);
        }
      } as never,
      Container: class {
        addChild = vi.fn();
      } as never,
      Graphics: class {
        circle = vi.fn();
        clear = vi.fn();
        stroke = vi.fn();
      } as never,
      Sprite: class {
        alpha = 1;
        height = 0;
        tint = 0;
        width = 0;
        constructor() {
          sprites.push(this);
        }
      } as never,
      Texture: class {
        destroy = vi.fn();
      } as never,
      createCanvas: () => uploadCanvas as unknown as HTMLCanvasElement,
      maxTextureSize: 4096,
      preview: { editor },
    });

    expect(sources[0]).toMatchObject({
      height: 614,
      resource: uploadCanvas,
      width: 4096,
    });
    expect(drawImage).toHaveBeenLastCalledWith(brushCanvas, 0, 0, 4096, 614);
    expect(sprites[0]).toMatchObject({ height: 1200, width: 8000 });

    textureListener!();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });
});
