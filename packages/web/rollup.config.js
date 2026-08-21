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
const trackingWorkerSentinel =
  "__SUPERVISION_JS_EMBEDDED_TRACKING_WORKER_SOURCE__";
const trackingWorkerPath = path.resolve(rootDir, "dist/tracking.worker.js");
const sourceAliasRoots = new Set([
  "constants",
  "detections",
  "media",
  "playback",
  "post-processing",
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

function embedWorkers() {
  let didEmbedMaskWorker = false;
  let didEmbedTrackingWorker = false;

  return {
    name: "embed-workers",
    buildStart() {
      this.addWatchFile(maskPreparationWorkerPath);
      this.addWatchFile(trackingWorkerPath);
    },
    renderChunk(code) {
      if (
        !code.includes(embeddedWorkerSentinel) &&
        !code.includes(trackingWorkerSentinel)
      ) {
        return null;
      }
      const maskWorkerSource = readFileSync(maskPreparationWorkerPath, "utf8")
        .trimEnd()
        .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");
      const trackingWorkerSource = readFileSync(trackingWorkerPath, "utf8")
        .trimEnd()
        .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");
      let embeddedCode = code.replace(
        JSON.stringify(embeddedWorkerSentinel),
        JSON.stringify(maskWorkerSource),
      );
      if (embeddedCode !== code) {
        didEmbedMaskWorker = true;
      }
      const withTrackingWorker = embeddedCode.replace(
        JSON.stringify(trackingWorkerSentinel),
        JSON.stringify(trackingWorkerSource),
      );
      if (withTrackingWorker !== embeddedCode) {
        didEmbedTrackingWorker = true;
      }
      embeddedCode = withTrackingWorker;

      return {
        code: embeddedCode,
        map: null,
      };
    },
    generateBundle() {
      if (!didEmbedMaskWorker || !didEmbedTrackingWorker) {
        throw new Error(
          "The browser package did not embed every public worker asset.",
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

const trackingWorkerConfig = {
  input: "src/post-processing/tracking.worker.ts",
  output: {
    file: "dist/tracking.worker.js",
    format: "iife",
    name: "SupervisionDetectionPostProcessingWorker",
    sourcemap: true,
  },
  plugins: [sourceAliasResolver(), privateCoreResolver(), typescriptPlugin()],
  treeshake: { moduleSideEffects: false },
};

const packageConfig = {
  input: {
    editing: "src/editing.ts",
    index: "src/index.ts",
  },
  external(source) {
    return (
      source === "mediabunny" ||
      source === "supervision-js-video-engine" ||
      source.startsWith("supervision-js-video-engine/") ||
      source === "pixi.js" ||
      source.startsWith("pixi.js/") ||
      source === "supervision-js-core"
    );
  },
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "es",
    sourcemap: true,
  },
  plugins: [sourceAliasResolver(), typescriptPlugin(), embedWorkers()],
  treeshake: {
    moduleSideEffects: false,
  },
};

export default [workerConfig, trackingWorkerConfig, packageConfig];
