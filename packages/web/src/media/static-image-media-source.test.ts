import { describe, expect, it, vi } from "vitest";
import { createStaticImageMediaSource } from "./static-image-media-source";

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
});
