import { describe, expect, it } from "vitest";

// @ts-expect-error Vitest supplies Vite's raw-module loader at test time.
import preparedFrameStoreSource from "./prepared-frame-store.ts?raw";

describe("PreparedFrameStore worklet transform", () => {
  it("emits a worklet-class factory for the saved-video packet owner", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const babel = require("@babel/core") as {
      transformSync(source: string, options: object): { code?: string } | null;
    };
    const result = babel.transformSync(preparedFrameStoreSource, {
      filename: "packages/react-native/src/renderers/prepared-frame-store.ts",
      plugins: [
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@babel/plugin-transform-typescript"),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("react-native-worklets/plugin"),
      ],
    });

    expect(result?.code).toContain("PreparedFrameStore__classFactory");
  });
});
