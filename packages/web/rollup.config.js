import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const embeddedWorkerSentinel =
  "__SUPERVISION_JS_EMBEDDED_MASK_PREPARATION_WORKER_SOURCE__";
const maskPreparationWorkerPath = path.resolve(
  rootDir,
  "dist/mask-preparation.worker.js",
);
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

function privateCoreResolver() {
  return {
    name: "private-core-resolver",
    resolveId(source) {
      if (source !== "supervision-js-core") {
        return null;
      }

      return path.resolve(rootDir, "../core/dist/index.js");
    },
  };
}

function typescriptPlugin() {
  return typescript({
    tsconfig: "./tsconfig.json",
    declaration: false,
    declarationMap: false,
  });
}

function embedMaskPreparationWorker() {
  let didEmbedWorker = false;

  return {
    name: "embed-mask-preparation-worker",
    buildStart() {
      this.addWatchFile(maskPreparationWorkerPath);
    },
    renderChunk(code) {
      if (!code.includes(embeddedWorkerSentinel)) {
        return null;
      }

      const workerSource = readFileSync(maskPreparationWorkerPath, "utf8")
        .trimEnd()
        .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");
      const embeddedCode = code.replace(
        JSON.stringify(embeddedWorkerSentinel),
        JSON.stringify(workerSource),
      );

      if (embeddedCode === code) {
        throw new Error(
          "Unable to replace the render-preparation worker source sentinel.",
        );
      }

      didEmbedWorker = true;

      return {
        code: embeddedCode,
        map: null,
      };
    },
    generateBundle() {
      if (!didEmbedWorker) {
        throw new Error(
          "The browser package did not embed the render-preparation worker.",
        );
      }
    },
  };
}

const workerConfig = {
  input: "src/render-preparation/mask-preparation.worker.ts",
  output: {
    file: "dist/mask-preparation.worker.js",
    format: "iife",
    name: "SupervisionMaskPreparationWorker",
    sourcemap: true,
  },
  plugins: [sourceAliasResolver(), privateCoreResolver(), typescriptPlugin()],
  treeshake: {
    moduleSideEffects: false,
  },
};

const packageConfig = {
  input: {
    editing: "src/editing.ts",
    index: "src/index.ts",
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
    typescriptPlugin(),
    embedMaskPreparationWorker(),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};

export default [workerConfig, packageConfig];
