import { describe, expect, it } from "vitest";

import {
  createFakeDecoderLog,
  openFakeDepthPreviewTrack,
  type FakeDecoderClip,
} from "../../../../test/fake-video-decoder";

const WIDTH = 8;
const HEIGHT = 4;

describe("depth preview track reader", () => {
  it("decodes each run from the key frame at or before it, on one decoder, copying on the page what the copier declines", async () => {
    const log = createFakeDecoderLog();
    const declining = {
      copy: () => null,
      destroy: () => undefined,
      offMainThread: true,
    };
    const reader = openFakeDepthPreviewTrack(
      "outputs",
      clip({ frameCount: 48, keyEvery: 24 }),
      { copier: declining },
      log,
    );
    const first = reader.decode(30);

    expect(await first.next()).toEqual(frame(24));

    const second = reader.decode(0, { keep: (index) => index >= 3 });

    expect(await first.next()).toBeNull();
    expect(await second.next()).toEqual(frame(3));
    expect(log.created).toBe(1);
    reader.dispose();
  });

  it("fails a run whose decoder errors, and decodes the next run on a fresh decoder", async () => {
    const reader = openFakeDepthPreviewTrack(
      "failsOnce",
      clip({ frameCount: 8, keyEvery: 24 }),
    );
    const run = reader.decode(0);

    expect(await run.next()).toEqual(frame(0));
    await expect(run.next()).rejects.toThrow("Decoder lost.");
    expect(await reader.decode(0).next()).toEqual(frame(0));
    reader.dispose();
  });

  it("gets a decoder that holds every frame to return them a key frame at a time, and loses none", async () => {
    const log = createFakeDecoderLog();
    const reader = openFakeDepthPreviewTrack(
      "holdsUntilFlush",
      clip({ frameCount: 60, keyEvery: 24 }),
      {},
      log,
    );
    const run = reader.decode(0);
    const indices: number[] = [];

    for (let next = await run.next(); next; next = await run.next()) {
      if (indices.length === 0) expect(log.fed).toBeLessThan(60);
      indices.push(next.index);
    }

    expect(indices).toEqual(Array.from({ length: 60 }, (_, index) => index));
    reader.dispose();
  });

  it("lets a cancelled run go at once while a packet read is still pending", async () => {
    const reader = openFakeDepthPreviewTrack("outputs", {
      ...clip({ frameCount: 8, keyEvery: 24 }),
      packetsReady: new Promise(() => undefined),
    });
    const run = reader.decode(0);
    const pending = run.next();

    run.cancel();
    await expect(pending).resolves.toBeNull();
    reader.dispose();
  });
});

function clip(options: {
  frameCount: number;
  keyEvery: number;
}): FakeDecoderClip {
  return { ...options, frameRate: 24, height: HEIGHT, luma, width: WIDTH };
}

function luma(index: number) {
  return Uint8Array.from(
    { length: WIDTH * HEIGHT },
    (_, pixel) => (index * 7 + pixel) & 0xff,
  );
}

function frame(index: number) {
  return { height: HEIGHT, index, luma: luma(index), width: WIDTH };
}
