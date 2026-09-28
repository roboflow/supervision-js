import { describe, expect, it, vi } from "vitest";

import { captureCanvasMediaFrame } from "./media-frame-capture";

describe("captureCanvasMediaFrame", () => {
  it("copies the presented media pixels before asynchronously encoding them", async () => {
    const drawImage = vi.fn();
    let completeEncoding: ((blob: Blob | null) => void) | undefined;
    const source = { height: 360, width: 640 } as HTMLCanvasElement;
    const snapshot = {
      getContext: vi.fn(() => ({ drawImage })),
      height: 0,
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        completeEncoding = callback;
      }),
      width: 0,
    } as unknown as HTMLCanvasElement;

    const capture = captureCanvasMediaFrame({
      capture: undefined,
      createCanvas: () => snapshot,
      mediaTime: 1.25,
      source,
    });

    expect(snapshot.width).toBe(640);
    expect(snapshot.height).toBe(360);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 640, 360);

    source.width = 1;
    source.height = 1;
    completeEncoding?.(new Blob(["frame"], { type: "image/jpeg" }));

    await expect(capture).resolves.toMatchObject({
      height: 360,
      mediaTime: 1.25,
      type: "image/jpeg",
      width: 640,
    });
  });

  it("draws a downscaled source back up to the requested media size", async () => {
    const drawImage = vi.fn();
    const source = { height: 614, width: 4096 } as HTMLCanvasElement;
    const snapshot = {
      getContext: () => ({ drawImage }),
      height: 0,
      toBlob: (callback: (blob: Blob | null) => void) =>
        callback(new Blob(["frame"], { type: "image/jpeg" })),
      width: 0,
    } as unknown as HTMLCanvasElement;

    const capture = await captureCanvasMediaFrame({
      capture: undefined,
      createCanvas: () => snapshot,
      mediaTime: 0,
      size: { height: 1200, width: 8000 },
      source,
    });

    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 8000, 1200);
    expect(capture).toMatchObject({ height: 1200, width: 8000 });
  });

  it("rejects invalid encoder quality before copying the media canvas", async () => {
    const createCanvas = vi.fn();

    await expect(
      captureCanvasMediaFrame({
        capture: { quality: 1.1 },
        createCanvas,
        mediaTime: 0,
        source: { height: 1, width: 1 } as HTMLCanvasElement,
      }),
    ).rejects.toThrow("quality must be a number between 0 and 1");

    expect(createCanvas).not.toHaveBeenCalled();
  });
});
