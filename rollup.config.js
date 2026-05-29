import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const sourceAliasRoots = new Set([
  "constants",
  "detections",
  "media",
  "playback",
  "renderers",
  "sessions",
  "styles",
  "types",
  "utils",
]);

function sourceAliasResolver() {
  return {
    name: "source-alias-resolver",
    resolveId(source) {
      const match = /^#([^/]+)\/(.+)$/.exec(source);

      if (!match || !sourceAliasRoots.has(match[1])) {
        return null;
      }

      return path.resolve(rootDir, "src", match[1], `${match[2]}.ts`);
    },
  };
}

export default {
  input: "src/index.ts",
  external: ["mediabunny", "pixi.js"],
  output: {
    file: "dist/index.js",
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
