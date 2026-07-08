import { afterEach, describe, expect, it, vi } from "vitest";

describe("React Native demo presentation worklet boundaries", () => {
  afterEach(() => {
    vi.doUnmock("supervision-js-react-native");
    vi.resetModules();
  });

  it("resolves colors without depending on an imported package function at runtime", async () => {
    vi.doMock("supervision-js-react-native", () => ({
      resolveReactNativeLiveColorForClass: undefined,
    }));

    const { resolveDemoDetectionColor } = await import("./demo-presentation");

    expect(
      resolveDemoDetectionColor(
        {
          className: "tv",
          rect: { height: 1, width: 1, x: 0, y: 0 },
        },
        0,
      ),
    ).toBe(0xa78bfa);
  });
});
