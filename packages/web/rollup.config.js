import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import typescript from "@rollup/plugin-typescript";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const videoEngineDistDir = path.resolve(rootDir, "../video-engine/dist");
const videoEngineStagedDir = "web-video-engine";
/**
 * The engine's own build names its root entry `index`, which is the name the
 * public `supervision/web-video-engine` barrel takes in the staged directory.
 */
const videoEngineStagedRoot = "engine";
const videoEngineModules = {
  "#web-video-engine": `${videoEngineStagedDir}/${videoEngineStagedRoot}.js`,
  "#web-video-engine/analysis": `${videoEngineStagedDir}/analysis.js`,
};
const videoEngineBarrelModules = {
  ...videoEngineModules,
  supervision: "index.js",
};
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

/**
 * The engine is a private workspace package, so an installed `supervision` has
 * no other copy of it to resolve. Its own build already emitted the chunking,
 * declarations and source maps the engine entries point at, and rebuilding them
 * here would produce a second copy of a 1.5 MB embedded worker.
 */
function stageVideoEngine() {
  return {
    name: "stage-video-engine",
    buildStart() {
      for (const file of listFiles(videoEngineDistDir)) {
        this.addWatchFile(file);
      }
    },
    generateBundle() {
      const files = listFiles(videoEngineDistDir);

      if (files.length === 0) {
        throw new Error(
          "The video engine has no build output to stage; build supervision-js-web-video-engine first.",
        );
      }

      for (const file of files) {
        const staged = stagedVideoEngineName(
          path.relative(videoEngineDistDir, file).split(path.sep).join("/"),
        );

        this.emitFile({
          fileName: path.posix.join(videoEngineStagedDir, staged.name),
          source: staged.source(file),
          type: "asset",
        });
      }
    },
  };
}

function stagedVideoEngineName(relativePath) {
  const match = /^index(\.d\.ts|\.js)(\.map)?$/.exec(relativePath);

  if (!match) {
    return { name: relativePath, source: (file) => readFileSync(file) };
  }

  return {
    name: `${videoEngineStagedRoot}${match[1]}${match[2] ?? ""}`,
    source: (file) =>
      readFileSync(file, "utf8").replaceAll(
        `index${match[1]}`,
        `${videoEngineStagedRoot}${match[1]}`,
      ),
  };
}

/**
 * These modules are external, so Rollup leaves their specifiers as written.
 * Emitting a path relative to each chunk is what lets the published package be
 * read by a resolver that supports nothing but relative imports.
 */
function resolveInternalSpecifiers(modules) {
  return {
    name: "resolve-internal-specifiers",
    renderChunk(code, chunk) {
      const fromDir = path.posix.dirname(chunk.fileName);
      let resolved = code;

      for (const [specifier, target] of Object.entries(modules)) {
        const relative = path.posix.relative(fromDir, target);

        resolved = resolved.replaceAll(
          `"${specifier}"`,
          `"${relative.startsWith(".") ? relative : `./${relative}`}"`,
        );
        resolved = resolved.replaceAll(
          `'${specifier}'`,
          `'${relative.startsWith(".") ? relative : `./${relative}`}'`,
        );
      }

      return resolved === code ? null : { code: resolved, map: null };
    },
  };
}

function listFiles(directory) {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
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
      source in videoEngineModules ||
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
  plugins: [
    sourceAliasResolver(),
    typescriptPlugin(),
    embedWorkers(),
    resolveInternalSpecifiers(videoEngineModules),
    stageVideoEngine(),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};

/**
 * The barrel re-exports the staged engine and the browser package's own adapter
 * for it. Built on its own so that Rollup never sees the engine and the entry
 * that lazily loads it in one graph: given both, it hoists the engine into a
 * static import of the main entry, and the main entry stops being the thing a
 * consumer who only annotates images can afford.
 */
const videoEngineBarrelConfig = {
  input: "src/web-video-engine/index.ts",
  external(source) {
    return source in videoEngineBarrelModules;
  },
  output: {
    dir: "dist",
    entryFileNames: `${videoEngineStagedDir}/[name].js`,
    format: "es",
    sourcemap: true,
  },
  plugins: [
    typescriptPlugin(),
    resolveInternalSpecifiers(videoEngineBarrelModules),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};

export default [
  workerConfig,
  trackingWorkerConfig,
  packageConfig,
  videoEngineBarrelConfig,
];
