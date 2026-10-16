import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaErrorKind } from "supervision-js-core";
import { getMediaErrorKind, isMediaSourceError } from "#media/media-errors";
import { createStaticImageMediaSource } from "./static-image-media-source";

class TestImage {
  width = 160;
  height = 90;
  naturalWidth = 1920;
  naturalHeight = 1080;
  complete = true;
  decode = vi.fn(async () => {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static image media source", () => {
  it("adapts a host-drawn frame to the decoded media source seam", async () => {
    const draw = vi.fn();
    const source = await createStaticImageMediaSource({
      width: 320,
      height: 200,
      draw,
    }).open();
    expect(source.metadata).toMatchObject({
      duration: 0,
      formatName: "static-image",
      primaryVideoHeight: 200,
      primaryVideoWidth: 320,
    });
    const sample = await source.sampleSink.getSample(0);
    const context = {} as CanvasRenderingContext2D;
    sample?.draw(context, 1, 2, 30, 40);
    expect(draw).toHaveBeenCalledWith(context, 1, 2, 30, 40);
  });

  it("reports an unusable image as a typed media failure", async () => {
    const open = createStaticImageMediaSource({
      width: 0,
      height: 0,
      draw: vi.fn(),
    }).open();

    await expect(open).rejects.toSatisfy(
      (error: unknown) =>
        isMediaSourceError(error) &&
        getMediaErrorKind(error) === MediaErrorKind.Unreadable,
    );
  });

  it.each([
    [160, 90],
    [0, 0],
  ])(
    "uses intrinsic image dimensions with a displayed size of %s x %s",
    async (width, height) => {
      vi.stubGlobal("HTMLImageElement", TestImage);
      const image = new TestImage();
      image.width = width;
      image.height = height;
      const source = await createStaticImageMediaSource(
        image as unknown as HTMLImageElement,
      ).open();

      expect(source.metadata).toMatchObject({
        primaryVideoWidth: 1920,
        primaryVideoHeight: 1080,
      });
      const drawImage = vi.fn();
      const sample = await source.sampleSink.getSample(0);
      sample?.draw({ drawImage } as unknown as CanvasRenderingContext2D, 3, 4);
      expect(drawImage).toHaveBeenCalledWith(image, 3, 4, 1920, 1080);
      expect(image.decode).not.toHaveBeenCalled();
    },
  );

  it("waits for image decoding before reading intrinsic dimensions", async () => {
    vi.stubGlobal("HTMLImageElement", TestImage);
    const image = new TestImage();
    image.complete = false;
    image.naturalWidth = 0;
    image.naturalHeight = 0;
    let finishDecode!: () => void;
    image.decode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDecode = () => {
            image.naturalWidth = 800;
            image.naturalHeight = 600;
            resolve();
          };
        }),
    );

    const open = createStaticImageMediaSource(
      image as unknown as HTMLImageElement,
    ).open();
    let settled = false;
    void open.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(image.decode).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finishDecode();
    const source = await open;
    expect(source.metadata).toMatchObject({
      primaryVideoWidth: 800,
      primaryVideoHeight: 600,
    });
  });

  it("uses VideoFrame display dimensions without requiring its global constructor", async () => {
    vi.stubGlobal("VideoFrame", undefined);
    const frame = {
      codedWidth: 1920,
      codedHeight: 1088,
      visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 90,
      close: vi.fn(),
    };
    const source = await createStaticImageMediaSource(
      frame as unknown as VideoFrame,
    ).open();

    expect(source.metadata).toMatchObject({
      primaryVideoWidth: 1080,
      primaryVideoHeight: 1920,
    });
    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    const sample = await source.sampleSink.getSample(0);
    sample?.draw(context, 1, 2);
    expect(drawImage).toHaveBeenLastCalledWith(frame, 1, 2, 1080, 1920);
    sample?.draw(context, 1, 2, 300, 400);
    expect(drawImage).toHaveBeenLastCalledWith(frame, 1, 2, 300, 400);
    sample?.close();
    source.input.dispose();
    expect(frame.close).not.toHaveBeenCalled();
    expect(await source.sampleSink.getSample(0)).toBe(sample);
  });

  it("preserves width/height source dimensions and caller ownership", async () => {
    const image = { width: 640, height: 480, close: vi.fn() };
    const source = await createStaticImageMediaSource(
      image as unknown as ImageBitmap,
    ).open();
    expect(source.metadata).toMatchObject({
      primaryVideoWidth: 640,
      primaryVideoHeight: 480,
    });
    const drawImage = vi.fn();
    const sample = await source.sampleSink.getSample(0);
    sample?.draw({ drawImage } as unknown as CanvasRenderingContext2D, 0, 0);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 640, 480);
    sample?.close();
    source.input.dispose();
    expect(image.close).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid source dimensions (%s) instead of falling back to a different size",
    async (invalid) => {
      vi.stubGlobal("HTMLImageElement", TestImage);
      for (const dimension of ["width", "height"] as const) {
        const image = new TestImage();
        if (dimension === "width") image.naturalWidth = invalid;
        else image.naturalHeight = invalid;
        const frame = { displayWidth: 640, displayHeight: 480 };
        if (dimension === "width") frame.displayWidth = invalid;
        else frame.displayHeight = invalid;
        const host = { width: 640, height: 480, draw: vi.fn() };
        host[dimension] = invalid;

        for (const input of [
          image as unknown as HTMLImageElement,
          frame as unknown as VideoFrame,
          host,
        ]) {
          await expect(
            createStaticImageMediaSource(input).open(),
          ).rejects.toSatisfy(
            (error: unknown) =>
              isMediaSourceError(error) &&
              getMediaErrorKind(error) === MediaErrorKind.Unreadable,
          );
        }
      }
    },
  );
});
