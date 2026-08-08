import { describe, expect, it } from "vitest";

// @ts-expect-error Vitest supplies Vite's raw-module loader at test time.
import executorchSource from "./executorch.ts?raw";
// @ts-expect-error Vitest supplies Vite's raw-module loader at test time.
import liveInferenceSource from "../react/use-live-inference.ts?raw";

describe("ExecuTorch pose worklet transform", () => {
  it("declares local pose worklets before consumers capture them", () => {
    const converterIndex = liveInferenceSource.indexOf(
      "function toInstantCvPoses",
    );
    const consumerIndex = liveInferenceSource.indexOf(
      "function evaluateLiveInferencePoseExtension",
    );

    expect(converterIndex).toBeGreaterThanOrEqual(0);
    expect(consumerIndex).toBeGreaterThan(converterIndex);
  });

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

  it("keeps pose conversion free of fragile nested helpers and array methods", () => {
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

    expect(result?.code).not.toContain("unrotateExecutorchUpPoint");
    expect(result?.code).not.toContain(".flatMap(");
  });
});
