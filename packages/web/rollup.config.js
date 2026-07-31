import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const sourceAliasRoots = new Set([
  "constants",
  "detections",
  "media",
  "playback",
  "render-preparation",
  "renderers",
  "sessions",
  "types",
  "workers",
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

/**
 * Keep the worker entry option in the published ESM for webpack consumers.
 * Rollup drops non-legal comments, while webpack reads this magic comment from
 * the expression it parses in `node_modules`, not from supervision-js source.
 */
function preserveWebpackWorkerEntryOptions() {
  const expression = 'new URL("./mask-preparation.worker.js", import.meta.url)';
  const replacement = `new URL(
        /* webpackEntryOptions: { publicPath: "/" } */
        "./mask-preparation.worker.js",
        import.meta.url
      )`;

  return {
    name: "preserve-webpack-worker-entry-options",
    renderChunk(code) {
      if (!code.includes(expression)) {
        return null;
      }

      return {
        code: code.replace(expression, replacement),
        map: null,
      };
    },
  };
}

export default {
  input: {
    editing: "src/editing.ts",
    index: "src/index.ts",
    "mask-preparation.worker":
      "src/render-preparation/mask-preparation.worker.ts",
  },
  external: ["mediabunny", "pixi.js", "supervision-js-core"],
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
    preserveWebpackWorkerEntryOptions(),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};
