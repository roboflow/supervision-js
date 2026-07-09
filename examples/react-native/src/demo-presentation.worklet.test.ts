import { resolveDetectionClassColorStyle } from "supervision-js-core";
import { describe, expect, it } from "vitest";

import { resolveDemoDetectionColor } from "./demo-presentation";

describe("React Native demo presentation colors", () => {
  it("delegates class colors to core's own resolver", () => {
    // Same function web uses — one color story across web and RN.
    expect(
      resolveDemoDetectionColor({
        className: "tv",
        rect: { height: 1, width: 1, x: 0, y: 0 },
      }),
    ).toBe(resolveDetectionClassColorStyle("tv").fill);
  });

  it("prefers an explicit metadata color over the class color", () => {
    expect(
      resolveDemoDetectionColor({
        className: "tv",
        metadata: { color: 0x123456 },
        rect: { height: 1, width: 1, x: 0, y: 0 },
      }),
    ).toBe(0x123456);
  });
});
