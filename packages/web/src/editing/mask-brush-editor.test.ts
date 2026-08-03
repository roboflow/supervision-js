import { decodeCompressedRleMask } from "supervision-js-core";
import { describe, expect, it, vi } from "vitest";

import { MaskBrushMode, createMaskBrushEditor } from "./mask-brush-editor";

describe("mask brush editor", () => {
  it("separates cursor updates from bounded raster updates", () => {
    const { canvas, reads } = createCanvasHarness(64, 48);
    const onCursorUpdate = vi.fn();
    const onTextureUpdate = vi.fn();
    const editor = createMaskBrushEditor({
      canvas,
      height: 48,
      onCursorUpdate,
      onTextureUpdate,
      width: 64,
    });
    const cursorListener = vi.fn();
    const textureListener = vi.fn();
    editor.subscribeCursorUpdates(cursorListener);
    editor.subscribeTextureUpdates(textureListener);

    editor.setCursor({ x: 12, y: 10 }, { radius: 3 });

    expect(onCursorUpdate).toHaveBeenCalledTimes(1);
    expect(cursorListener).toHaveBeenCalledTimes(1);
    expect(onTextureUpdate).not.toHaveBeenCalled();
    expect(textureListener).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);

    editor.beginStroke({ x: 12, y: 10 }, { radius: 3 });
    editor.extendStroke({ x: 18, y: 14 });

    expect(onTextureUpdate).toHaveBeenCalledTimes(2);
    expect(textureListener).toHaveBeenCalledTimes(2);
    expect(onCursorUpdate).toHaveBeenCalledTimes(3);
    expect(reads).toHaveLength(2);
    expect(reads.every((read) => read.width < 64 && read.height < 48)).toBe(
      true,
    );

    const readsBeforeCommit = reads.length;
    const mask = editor.endStroke();
    expect(editor.getMaskBounds()).toEqual({
      height: expect.any(Number),
      width: expect.any(Number),
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(reads).toHaveLength(readsBeforeCommit);
    expect(
      decodeCompressedRleMask(mask).data.some((value) => value === 1),
    ).toBe(true);
  });

  it("restores only the touched raster when a stroke is cancelled", () => {
    const { canvas, reads } = createCanvasHarness(32, 32);
    const editor = createMaskBrushEditor({ canvas, height: 32, width: 32 });

    editor.beginStroke({ x: 8, y: 8 }, { radius: 2 });
    editor.endStroke();
    const before = editor.getMask();
    const readsBeforeCancelledStroke = reads.length;

    editor.beginStroke(
      { x: 20, y: 20 },
      { mode: MaskBrushMode.Add, radius: 2 },
    );
    editor.extendStroke({ x: 24, y: 24 });
    editor.cancelStroke();

    expect(editor.getMask()).toEqual(before);
    expect(
      reads
        .slice(readsBeforeCancelledStroke)
        .every((read) => read.width < 32 && read.height < 32),
    ).toBe(true);
  });
});

function createCanvasHarness(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const reads: Array<{ height: number; width: number; x: number; y: number }> =
    [];
  let currentArc = { radius: 0, x: 0, y: 0 };
  let operation: GlobalCompositeOperation = "source-over";

  const context = {
    arc(x: number, y: number, radius: number) {
      currentArc = { radius, x, y };
    },
    beginPath() {},
    clearRect(x: number, y: number, rectWidth: number, rectHeight: number) {
      for (let py = y; py < y + rectHeight; py += 1) {
        for (let px = x; px < x + rectWidth; px += 1) {
          pixels.fill(0, (py * width + px) * 4, (py * width + px + 1) * 4);
        }
      }
    },
    createImageData(rectWidth: number, rectHeight: number) {
      return {
        colorSpace: "srgb",
        data: new Uint8ClampedArray(rectWidth * rectHeight * 4),
        height: rectHeight,
        width: rectWidth,
      } as ImageData;
    },
    fill() {
      const left = Math.max(
        0,
        Math.floor(currentArc.x - currentArc.radius - 1),
      );
      const top = Math.max(0, Math.floor(currentArc.y - currentArc.radius - 1));
      const right = Math.min(
        width,
        Math.ceil(currentArc.x + currentArc.radius + 1),
      );
      const bottom = Math.min(
        height,
        Math.ceil(currentArc.y + currentArc.radius + 1),
      );
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          if (
            Math.hypot(x + 0.5 - currentArc.x, y + 0.5 - currentArc.y) >
            currentArc.radius
          ) {
            continue;
          }
          const offset = (y * width + x) * 4;
          const value = operation === "destination-out" ? 0 : 255;
          pixels[offset] = value;
          pixels[offset + 1] = value;
          pixels[offset + 2] = value;
          pixels[offset + 3] = value;
        }
      }
    },
    getImageData(x: number, y: number, rectWidth: number, rectHeight: number) {
      reads.push({ height: rectHeight, width: rectWidth, x, y });
      const data = new Uint8ClampedArray(rectWidth * rectHeight * 4);
      for (let py = 0; py < rectHeight; py += 1) {
        const source = ((y + py) * width + x) * 4;
        data.set(
          pixels.subarray(source, source + rectWidth * 4),
          py * rectWidth * 4,
        );
      }
      return { data, height: rectHeight, width: rectWidth } as ImageData;
    },
    putImageData(image: ImageData, x: number, y: number) {
      for (let py = 0; py < image.height; py += 1) {
        const target = ((y + py) * width + x) * 4;
        pixels.set(
          image.data.subarray(py * image.width * 4, (py + 1) * image.width * 4),
          target,
        );
      }
    },
    restore() {},
    save() {},
    set fillStyle(_value: string) {},
    get globalCompositeOperation() {
      return operation;
    },
    set globalCompositeOperation(value: GlobalCompositeOperation) {
      operation = value;
    },
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    getContext: () => context,
    height,
    width,
  } as unknown as HTMLCanvasElement;

  return { canvas, reads };
}
