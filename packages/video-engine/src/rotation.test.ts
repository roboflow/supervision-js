import { describe, expect, it } from "vitest";

import {
  paintedCorners,
  QUARTER_TURNS,
  shaderCorners,
  TransformRecorder,
  turnedSize,
} from "../test/rotation-probe";
import { drawRotated, uvRotationMatrix } from "./rotation";

/** The recorder never touches the image, only where it was told to put it. */
const IMAGE = {} as CanvasImageSource;

describe("drawRotated", () => {
  it.each(QUARTER_TURNS)(
    "paints a %i-degree track the way mediabunny's own sinks paint it",
    (rotation) => {
      const [width, height] = turnedSize(rotation);
      const recorder = new TransformRecorder();

      drawRotated(recorder.asContext(), IMAGE, rotation, 0, 0, width, height);

      expect(recorder.cornersOver(width, height)).toEqual(
        paintedCorners(rotation),
      );
    },
  );

  it("leaves an unrotated frame on the bare drawImage it was always on", () => {
    const calls: unknown[][] = [];
    const context = {
      drawImage: (...args: unknown[]) => calls.push(args),
      save: () => expect.unreachable("an unrotated frame saved the context"),
      restore: () => expect.unreachable("an unrotated frame restored it"),
      translate: () =>
        expect.unreachable("an unrotated frame moved the origin"),
      rotate: () => expect.unreachable("an unrotated frame turned the context"),
      scale: () => expect.unreachable("an unrotated frame scaled the context"),
    } as unknown as OffscreenCanvasRenderingContext2D;

    drawRotated(context, IMAGE, 0, 0, 0, 640, 360);

    expect(calls).toEqual([[IMAGE, 0, 0, 640, 360]]);
  });

  it("centres the turn on the destination box, not on the canvas origin", () => {
    const recorder = new TransformRecorder();

    drawRotated(recorder.asContext(), IMAGE, 90, 100, 200, 360, 640);

    expect(recorder.cornersOver(360, 640, 100, 200)).toEqual(
      paintedCorners(90),
    );
  });
});

describe("uvRotationMatrix", () => {
  it.each(QUARTER_TURNS)(
    "samples a %i-degree frame into the same corners the 2D draw paints it",
    (rotation) => {
      expect(shaderCorners(rotation)).toEqual(paintedCorners(rotation));
    },
  );

  it("leaves an unrotated frame sampling itself", () => {
    expect(uvRotationMatrix(0)).toEqual([1, 0, 0, 1]);
  });
});
