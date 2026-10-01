import { afterEach, describe, expect, it, vi } from "vitest";

import { DepthPreparationWorkerMessageType } from "./depth-preparation-worker-protocol";
import { createDepthPreviewLumaCopier } from "./depth-preview-luma-copier";
import {
  createMainThreadLumaCopier,
  readVideoFrameLuma,
} from "./depth-preview-luma";
import { RenderPreparationMode } from "#types/render-preparation";

const WIDTH = 6;
const HEIGHT = 2;
const codes = Array.from({ length: WIDTH * HEIGHT }, (_, i) => 16 + i * 9);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A decoded frame: luma in plane 0 (I420, rows `stride` wide), or BGRX. */
function fakeFrame(format: "I420" | "BGRX" | null, stride = WIDTH) {
  const frame = {
    close: vi.fn(() => {
      frame.codedWidth = 0;
    }),
    codedHeight: HEIGHT,
    codedWidth: WIDTH,
    format,
    visibleRect: { height: HEIGHT, width: WIDTH, x: 0, y: 0 },
    allocationSize: () =>
      format === "I420" ? stride * HEIGHT * 2 : WIDTH * HEIGHT * 4,
    async copyTo(destination: ArrayBuffer) {
      const bytes = new Uint8Array(destination);

      if (format === "I420") {
        for (let y = 0; y < HEIGHT; y += 1) {
          for (let x = 0; x < WIDTH; x += 1) {
            bytes[y * stride + x] = codes[y * WIDTH + x];
          }
        }
        return [{ offset: 0, stride }];
      }
      codes.forEach((code, pixel) => {
        bytes.set([7, code, 9, 255], pixel * 4);
      });
      return [{ offset: 0, stride: WIDTH * 4 }];
    },
  };

  return frame;
}

describe("readVideoFrameLuma", () => {
  it("copies plane 0 of a planar frame, rows wider than the frame included", async () => {
    const copied = await readVideoFrameLuma(
      fakeFrame("I420", WIDTH + 4) as unknown as VideoFrame,
      { buffer: new ArrayBuffer(0) },
    );

    expect([...copied.luma]).toEqual(codes);
    expect(copied).toMatchObject({
      height: HEIGHT,
      path: "plane",
      width: WIDTH,
    });
  });

  it("takes green from a frame handed over in RGB", async () => {
    const copied = await readVideoFrameLuma(
      fakeFrame("BGRX") as unknown as VideoFrame,
      { buffer: new ArrayBuffer(0) },
    );

    expect([...copied.luma]).toEqual(codes);
    expect(copied.path).toBe("rgb");
  });

  it("maps codes through a correction table, and leaves the frame open", async () => {
    const frame = fakeFrame("I420");
    const copied = await readVideoFrameLuma(
      frame as unknown as VideoFrame,
      { buffer: new ArrayBuffer(0) },
      Uint8Array.from({ length: 256 }, (_, code) => 255 - code),
    );

    expect([...copied.luma]).toEqual(codes.map((code) => 255 - code));
    expect(frame.close).not.toHaveBeenCalled();
  });
});

describe("depth preview luma copier", () => {
  it("copies on the page and closes each frame", async () => {
    const copier = createMainThreadLumaCopier();
    const frame = fakeFrame("I420");
    const copied = await copier.copy(frame as unknown as VideoFrame, null);

    expect([...copied!.luma]).toEqual(codes);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(copier.offMainThread).toBe(false);
  });

  it("hands frames to the worker, transferred, and takes the luma back", async () => {
    const { posts, worker } = fakeWorker("copy");
    const copier = createDepthPreviewLumaCopier({
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });
    const frame = fakeFrame("I420");
    const copied = await copier.copy(
      frame as unknown as VideoFrame,
      new Uint8Array(256).map((_, code) => code),
    );

    expect(copier.offMainThread).toBe(true);
    expect(posts[0]?.transfer).toEqual([frame]);
    expect(posts[0]?.message).toMatchObject({
      type: DepthPreparationWorkerMessageType.PreviewLuma,
    });
    expect([...copied!.luma]).toEqual(codes);
    copier.destroy();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("declines a frame it cannot send to the worker, and every one after, leaving it open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { posts, worker } = fakeWorker("refuse");
    const copier = createDepthPreviewLumaCopier({
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });
    const first = fakeFrame("I420");
    const second = fakeFrame("I420");

    expect(copier.copy(first as unknown as VideoFrame, null)).toBeNull();
    expect(first.close).not.toHaveBeenCalled();
    expect(copier.copy(second as unknown as VideoFrame, null)).toBeNull();
    expect(posts).toHaveLength(1);
    expect(copier.offMainThread).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("loses only the frame a failing worker took, and declines later ones", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { worker } = fakeWorker("error");
    const copier = createDepthPreviewLumaCopier({
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });

    expect(
      await copier.copy(fakeFrame("I420") as unknown as VideoFrame, null),
    ).toBeNull();
    expect(
      copier.copy(fakeFrame("I420") as unknown as VideoFrame, null),
    ).toBeNull();
  });

  it("never falls back when the mode requires the worker", async () => {
    const { worker } = fakeWorker("error");
    const copier = createDepthPreviewLumaCopier({
      mode: RenderPreparationMode.Worker,
      workerFactory: { createWorker: () => worker as unknown as Worker },
    });

    await expect(
      copier.copy(fakeFrame("I420") as unknown as VideoFrame, null),
    ).rejects.toThrow("copy failed");
  });

  it("leaves every frame to the page in main-thread mode", () => {
    const createWorker = vi.fn();
    const copier = createDepthPreviewLumaCopier({
      mode: RenderPreparationMode.MainThread,
      workerFactory: { createWorker },
    });

    expect(
      copier.copy(fakeFrame("I420") as unknown as VideoFrame, null),
    ).toBeNull();
    expect(createWorker).not.toHaveBeenCalled();
  });
});

type Listener = (event: { data?: unknown }) => void;

/**
 * A worker double that copies with the real luma reader, refuses the frame
 * the way a browser that cannot send one does, or answers with an error.
 */
function fakeWorker(behaviour: "copy" | "refuse" | "error") {
  const listeners = new Map<string, Listener[]>();
  const posts: { message: Record<string, unknown>; transfer: unknown[] }[] = [];
  const emit = (type: string, event: { data?: unknown }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const worker = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    postMessage(message: Record<string, unknown>, transfer: unknown[] = []) {
      if (behaviour === "refuse") {
        posts.push({ message, transfer });
        throw new DOMException(
          "VideoFrame could not be cloned.",
          "DataCloneError",
        );
      }
      posts.push({ message, transfer });

      const frame = message.frame as ReturnType<typeof fakeFrame>;
      // A transferred frame is detached on the sending side; the worker's
      // copy reads the same pixels.
      const sent = { ...frame, codedWidth: WIDTH };

      frame.codedWidth = 0;

      if (behaviour === "error") {
        sent.close();
        queueMicrotask(() =>
          emit("message", {
            data: {
              error: "copy failed",
              requestId: message.requestId,
              type: DepthPreparationWorkerMessageType.Error,
            },
          }),
        );
        return;
      }
      void readVideoFrameLuma(
        sent as unknown as VideoFrame,
        { buffer: new ArrayBuffer(0) },
        message.correction as Uint8Array | null,
      ).then((copied) => {
        sent.close();
        emit("message", {
          data: {
            height: copied.height,
            luma: copied.luma.buffer,
            path: copied.path,
            requestId: message.requestId,
            type: DepthPreparationWorkerMessageType.PreviewLumaComplete,
            width: copied.width,
          },
        });
      });
    },
    terminate: vi.fn(),
  };

  return { posts, worker };
}
