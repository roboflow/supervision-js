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
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);

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
