import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const sourceAliasRoots = new Set([
  "detections",
  "interactions",
  "post-processing",
  "styles",
  "types",
  "utils",
]);

function sourceAliasResolver() {
  return {
    name: "core-source-alias-resolver",
    resolveId(source) {
      const match = /^#([^/]+)\/(.+)$/.exec(source);

      if (!match || !sourceAliasRoots.has(match[1])) {
        return null;
      }

      return path.resolve(packageDir, "src", match[1], `${match[2]}.ts`);
    },
  };
}

export default {
  input: {
    index: "src/index.ts",
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "es",
    sourcemap: true,
  },
  plugins: [
    sourceAliasResolver(),
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      declarationMap: false,
    }),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};
