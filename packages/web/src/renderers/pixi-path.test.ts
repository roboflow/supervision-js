import { describe, expect, it } from "vitest";
import { BoxStrokeAlignment } from "supervision-js-core";

import { resolvePixiStroke } from "./pixi-path";

describe("Pixi path stroke translation", () => {
  it("preserves renderer-neutral stroke alignment", () => {
    expect(
      resolvePixiStroke(
        {
          alignment: BoxStrokeAlignment.Inside,
          alpha: 0.8,
          color: 0x123456,
          width: 4,
        },
        2,
      ),
    ).toEqual({
      alignment: 1,
      alpha: 0.8,
      color: 0x123456,
      width: 2,
    });

    expect(
      resolvePixiStroke(
        {
          alignment: BoxStrokeAlignment.Outside,
          alpha: 1,
          color: 0,
          width: 2,
        },
        1,
      ),
    ).toMatchObject({ alignment: 0 });
  });
});
