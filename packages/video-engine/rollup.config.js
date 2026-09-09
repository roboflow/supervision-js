import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const embeddedWorkerSentinel =
  "__SUPERVISION_JS_EMBEDDED_ENGINE_WORKER_SOURCE__";
const engineWorkerPath = path.resolve(rootDir, "dist/engine.worker.js");

/**
 * The worker is a classic script spawned from a Blob, so it has no module
 * loader and no import map: every bare specifier in its graph has to be
 * resolved here and bundled in. `mediabunny` is the only one, and it costs
 * about 200 KB gzipped on top of the 80 KB the engine itself needs. The
 * `analysis` entry keeps `mediabunny` external, so a consumer that imports both
 * ships it twice. Bundling it is what lets a host spawn the worker with no
 * bundler configuration at all, which is the whole point of embedding it.
 */
function mediabunnyResolver() {
  return {
    name: "mediabunny-resolver",
    resolveId(source) {
      if (source !== "mediabunny") {
        return null;
      }

      return fileURLToPath(import.meta.resolve("mediabunny"));
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

function embedEngineWorker() {
  let didEmbedWorker = false;

  return {
    name: "embed-engine-worker",
    buildStart() {
      this.addWatchFile(engineWorkerPath);
    },
    renderChunk(code) {
      if (!code.includes(embeddedWorkerSentinel)) {
        return null;
      }

      const workerSource = readFileSync(engineWorkerPath, "utf8")
        .trimEnd()
        .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");
      const embeddedCode = code.replace(
        JSON.stringify(embeddedWorkerSentinel),
        JSON.stringify(workerSource),
      );

      if (embeddedCode === code) {
        throw new Error("Unable to replace the engine worker source sentinel.");
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
          "The video-engine package did not embed the engine worker.",
        );
      }
    },
  };
}

/**
 * `mediabunny`'s browser entry reaches its Node file-source module, which
 * imports `node:fs/promises`. Nothing in the worker's graph can call it and
 * tree-shaking drops it before the chunk is emitted, so it is the one bare
 * specifier allowed to go unresolved. Any other one would be spelled as an
 * undefined global inside the IIFE, so both signals of that are fatal here.
 */
const workerUnresolvableSpecifiers = new Set(["node:fs/promises"]);

function isThirdPartyWarning(warning) {
  const ids = warning.ids ?? (warning.id ? [warning.id] : []);

  return ids.length > 0 && ids.every((id) => id.includes("node_modules"));
}

function onWorkerWarn(warning, warn) {
  if (warning.code === "MISSING_GLOBAL_NAME") {
    throw new Error(
      `The engine worker references the unbundled module "${warning.id}".`,
    );
  }

  if (warning.code === "UNRESOLVED_IMPORT") {
    if (workerUnresolvableSpecifiers.has(warning.exporter)) {
      return;
    }

    throw new Error(
      `The engine worker could not resolve "${warning.exporter}".`,
    );
  }

  if (isThirdPartyWarning(warning)) {
    return;
  }

  warn(warning);
}

const workerConfig = {
  input: "src/engine.worker.ts",
  onwarn: onWorkerWarn,
  output: {
    file: "dist/engine.worker.js",
    format: "iife",
    name: "SupervisionVideoEngineWorker",
    sourcemap: true,
  },
  plugins: [mediabunnyResolver(), typescriptPlugin()],
  treeshake: {
    moduleSideEffects: false,
  },
};

const packageConfig = {
  input: {
    analysis: "src/analysis.ts",
    index: "src/index.ts",
  },
  external(source) {
    return source === "mediabunny" || source.startsWith("mediabunny/");
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "es",
    sourcemap: true,
  },
  plugins: [typescriptPlugin(), embedEngineWorker()],
  treeshake: {
    moduleSideEffects: false,
  },
};

export default [workerConfig, packageConfig];
