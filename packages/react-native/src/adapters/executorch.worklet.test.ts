import { describe, expect, it } from "vitest";

// @ts-expect-error Vitest supplies Vite's raw-module loader at test time.
import executorchSource from "./executorch.ts?raw";

describe("ExecuTorch pose worklet transform", () => {
  it("captures the initialized pose-frame converter in the processor closure", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const babel = require("@babel/core") as {
      transformSync(source: string, options: object): { code?: string } | null;
    };
    const result = babel.transformSync(executorchSource, {
      filename: "packages/react-native/src/adapters/executorch.ts",
      plugins: [
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@babel/plugin-transform-typescript"),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("react-native-worklets/plugin"),
      ],
    });

    expect(result?.code).toContain("createDetectionFrame,");
    expect(result?.code).toContain("return createDetectionFrame({");
  });
});
