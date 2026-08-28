import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();
const trackersSourceDir = path.join(rootDir, "packages/trackers/src");
const coreSourceDir = path.join(rootDir, "packages/core/src");
const webSourceDir = path.join(rootDir, "packages/web/src");
const reactNativeSourceDir = path.join(rootDir, "packages/react-native/src");
const reactNativeExampleApp = path.join(
  rootDir,
  "examples/react-native/App.tsx",
);
const reactNativeExampleSourceDir = path.join(
  rootDir,
  "examples/react-native/src",
);

const publishedPackages = ["core", "react-native", "video-engine", "web"];
const videoEngineWorkspace = "supervision-js-web-video-engine";
const videoEngineEntry = "supervision/web-video-engine";
// The workspace name resolves inside this repository and nowhere else, and
// `#web-video-engine` names the staged build the subpath is served from. Each
// counts as reaching the engine just as much as the shipped entry does.
const videoEngineSpecifier =
  /["'](?:supervision\/web-video-engine|supervision-js-web-video-engine|#web-video-engine)(?:\/[^"']*)?["']/g;
// The media seam adapts the engine and the subpath barrel publishes it.
// Everything else in the workspace sees the general contracts that seam
// implements.
const videoEngineBarrelDir = path.join(
  rootDir,
  "packages/web/src/web-video-engine",
);
const videoEngineSeamDirs = [
  path.join(rootDir, "packages/web/src/media"),
  videoEngineBarrelDir,
];
// An import clause carries nothing but identifiers and punctuation, so a
// specifier reached past anything else is not an import at all: a string
// constant naming the package reads the same to a regular expression.
const staticValueImportClause =
  /^(?:import|export)\s+(?!type\b)[\w${},*\s]*\bfrom\s+$/;
const sideEffectImportClause = /^import\s+$/;
// `from` is only an import keyword when it is not itself quoted: a type such as
// `Pick<typeof Filter, "from">` otherwise swallows the rest of the file as a
// specifier. A specifier also never spans a line.
const importSpecifier =
  /(?:(?<!["'])\bfrom\s*|\bimport\s*[(\s]\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;

const forbiddenPatterns = [
  {
    label: "pixi.js import",
    pattern: /from\s+["']pixi\.js(?:\/[^"']*)?["']/,
  },
  {
    label: "mediabunny import",
    pattern: /from\s+["']mediabunny(?:\/[^"']*)?["']/,
  },
  {
    label: "web package alias",
    pattern:
      /from\s+["']#(?:constants|media|playback|render-preparation|renderers|sessions|workers)\//,
  },
  {
    label: "browser package import",
    pattern: /from\s+["']supervision["']/,
  },
  { label: "document global", pattern: /\bdocument\s*[.([]/ },
  { label: "window global", pattern: /\bwindow\s*[.([]/ },
  { label: "navigator global", pattern: /\bnavigator\s*[.([]/ },
  { label: "HTMLElement", pattern: /\bHTMLElement\b/ },
  { label: "HTMLCanvasElement", pattern: /\bHTMLCanvasElement\b/ },
  { label: "HTMLVideoElement", pattern: /\bHTMLVideoElement\b/ },
  { label: "HTMLImageElement", pattern: /\bHTMLImageElement\b/ },
  { label: "HTMLMediaElement", pattern: /\bHTMLMediaElement\b/ },
  { label: "OffscreenCanvas", pattern: /\bOffscreenCanvas\b/ },
  {
    label: "CanvasRenderingContext2D",
    pattern: /\bCanvasRenderingContext2D\b/,
  },
  { label: "Worker", pattern: /\bWorker\b/ },
  { label: "Blob", pattern: /\bBlob\b/ },
  {
    label: "File global",
    pattern: /(?::\s*File\b|\bnew\s+File\b|\binstanceof\s+File\b)/,
  },
  { label: "FileReader", pattern: /\bFileReader\b/ },
  { label: "ImageBitmap", pattern: /\bImageBitmap\b/ },
  { label: "createImageBitmap", pattern: /\bcreateImageBitmap\b/ },
  { label: "indexedDB", pattern: /\bindexedDB\b/ },
  { label: "fetch global", pattern: /\bfetch\s*[.([]/ },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { label: "localStorage", pattern: /\blocalStorage\b/ },
  { label: "sessionStorage", pattern: /\bsessionStorage\b/ },
  { label: "URL object URL", pattern: /\bURL\.(create|revoke)ObjectURL\b/ },
  { label: "CompressionStream", pattern: /\bCompressionStream\b/ },
  { label: "VideoFrame", pattern: /\bVideoFrame\b/ },
  { label: "VideoEncoder", pattern: /\bVideoEncoder\b/ },
  { label: "VideoDecoder", pattern: /\bVideoDecoder\b/ },
  { label: "WebGL", pattern: /\bWebGL(?:2)?RenderingContext\b/ },
  { label: "WebGPU", pattern: /\bGPU(?:Device|CanvasContext|Texture)\b/ },
];

test("core source stays free of browser and vendor runtime APIs", async () => {
  const files = await listSourceFiles(coreSourceDir);
  const failures = [];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("tracker engines stay behind their platform-neutral workspace boundary", async () => {
  const files = await listSourceFiles(trackersSourceDir);
  const failures = [];
  const forbiddenTrackerPatterns = [
    ...forbiddenPatterns,
    {
      label: "Supervision workspace import",
      pattern:
        /from\s+["'][^"']*(?:supervision-js-core|packages\/(?:core|web|react-native)|#(?:detections|post-processing|types|utils)\/)/,
    },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenTrackerPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("core consumes tracker engines only through the internal package name", async () => {
  const files = await listSourceFiles(coreSourceDir);
  const failures = [];
  const forbiddenCoreTrackerPatterns = [
    {
      label: "tracker workspace source path",
      pattern: /from\s+["'][^"']*packages\/trackers/,
    },
    {
      label: "relative tracker workspace import",
      pattern: /from\s+["'](?:\.\.\/)+trackers(?:\/|["'])/,
    },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenCoreTrackerPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("web source consumes core through the package boundary", async () => {
  const files = await listSourceFiles(webSourceDir);
  const failures = [];
  const forbiddenWebPatterns = [
    {
      label: "core source path",
      pattern: /from\s+["'][^"']*(?:packages\/core|supervision-js-core\/src)/,
    },
    {
      label: "relative core source import",
      pattern: /from\s+["'](?:\.\.\/)+core(?:\/|["'])/,
    },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenWebPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("the browser package ships the video engine as a lazily loaded subpath", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "packages/web/package.json"), "utf8"),
  );
  const engineManifest = JSON.parse(
    await readFile(
      path.join(rootDir, "packages/video-engine/package.json"),
      "utf8",
    ),
  );

  assert.equal(
    engineManifest.private,
    true,
    `${videoEngineWorkspace} must stay private: the engine is published as a subpath of supervision, not as a package of its own`,
  );
  assert.equal(manifest.peerDependencies?.[videoEngineWorkspace], undefined);
  assert.equal(manifest.dependencies?.[videoEngineWorkspace], undefined);
  assert.equal(
    manifest.devDependencies?.[videoEngineWorkspace],
    "file:../video-engine",
    "the engine is a build-time input whose output is staged into dist, so a runtime dependency would name a package npm cannot install",
  );

  for (const [subpath, target] of [
    [videoEngineEntry, "./dist/web-video-engine/index.js"],
    [`${videoEngineEntry}/analysis`, "./dist/web-video-engine/analysis.js"],
  ]) {
    const entry = manifest.exports[subpath.replace("supervision", ".")];

    assert.equal(entry?.import, target, `${subpath} must resolve to ${target}`);
    assert.equal(
      entry?.default,
      target,
      `${subpath} must answer a resolver that asks for no condition`,
    );
  }

  assert.equal(
    manifest.exports["./web-video-engine/worker"],
    "./dist/web-video-engine/engine.worker.js",
  );
  // The staged engine build is what the subpath serves, and it is reached
  // through an alias so that only the barrel publishes it.
  assert.equal(
    manifest.imports["#web-video-engine"]?.import,
    "./dist/web-video-engine/engine.js",
  );
  assert.equal(
    manifest.imports["#web-video-engine/analysis"]?.import,
    "./dist/web-video-engine/analysis.js",
  );

  // The barrel is the subpath, so it is the one module that may name the engine
  // statically. Every other module reaches it through `import()`.
  const files = (await listSourceFilesWithoutTests(webSourceDir)).filter(
    (file) => !file.startsWith(`${videoEngineBarrelDir}${path.sep}`),
  );
  const failures = [];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const statement of staticEngineImports(source)) {
      failures.push(
        `${path.relative(rootDir, file)} statically imports ${statement}`,
      );
    }
  }

  assert.deepEqual(failures, []);
});

test("the video engine stays behind the media seam it was written for", async () => {
  const files = (
    await Promise.all(
      [
        trackersSourceDir,
        coreSourceDir,
        reactNativeSourceDir,
        webSourceDir,
      ].map(listSourceFiles),
    )
  )
    .flat()
    .filter(
      (file) =>
        !videoEngineSeamDirs.some((seam) =>
          file.startsWith(`${seam}${path.sep}`),
        ),
    );
  const failures = [];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const [specifier] of source.matchAll(videoEngineSpecifier)) {
      failures.push(`${path.relative(rootDir, file)} names ${specifier}`);
    }
  }

  assert.deepEqual(failures, []);
});

test("React Native source stays independent from browser package code", async () => {
  const files = await listSourceFiles(reactNativeSourceDir);
  const failures = [];
  const forbiddenReactNativePatterns = [
    {
      label: "browser package import",
      pattern: /from\s+["']supervision["']/,
    },
    {
      label: "web source path",
      pattern: /from\s+["'][^"']*(?:packages\/web|supervision-js\/src)/,
    },
    {
      label: "Pixi import",
      pattern: /from\s+["']pixi\.js(?:\/[^"']*)?["']/,
    },
    {
      label: "Mediabunny import",
      pattern: /from\s+["']mediabunny(?:\/[^"']*)?["']/,
    },
    { label: "DOM global", pattern: /\b(?:document|window)\s*[.([]/ },
    {
      label: "browser media element",
      pattern: /\bHTML(?:Video|Image|Media)Element\b/,
    },
    { label: "IndexedDB", pattern: /\bindexedDB\b/ },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenReactNativePatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("React Native example delegates Skia presentation to the package", async () => {
  const source = stripComments(await readFile(reactNativeExampleApp, "utf8"));
  const forbiddenExamplePatterns = [
    {
      label: "React Native Skia import",
      pattern: /from\s+["']@shopify\/react-native-skia["']/,
    },
    {
      label: "package Skia subpath import",
      pattern: /from\s+["']supervision-js-react-native\/skia["']/,
    },
    {
      label: "low-level Skia frame factory",
      pattern: /\bcreateReactNativeSkia(?:Mask|Vector)Frame\b/,
    },
    {
      label: "native ID-mask builder handle",
      pattern: /\bloadReactNativeLiveIdMaskNativeBuilder\b/,
    },
  ];
  const failures = forbiddenExamplePatterns
    .filter(({ pattern }) => pattern.test(source))
    .map(({ label }) => `examples/react-native/App.tsx uses ${label}`);

  assert.deepEqual(failures, []);
});

test("React Native example keeps frame worklets and renderer ownership in the package", async () => {
  const files = [
    reactNativeExampleApp,
    ...(await listSourceFilesWithoutTests(reactNativeExampleSourceDir)),
  ];
  const forbiddenExamplePatterns = [
    {
      label: "React Native Skia import",
      pattern: /from\s+["']@shopify\/react-native-skia["']/,
    },
    {
      label: "Reanimated import",
      pattern: /from\s+["']react-native-reanimated["']/,
    },
    {
      label: "Worklets import",
      pattern: /from\s+["']react-native-worklets["']/,
    },
    {
      label: "VisionCamera import",
      pattern: /from\s+["']react-native-vision-camera["']/,
    },
    { label: "worklet directive", pattern: /["']worklet["']\s*;/ },
    { label: "VisionCamera frame-output hook", pattern: /\buseFrameOutput\b/ },
    {
      label: "VisionCamera frame-renderer hook",
      pattern: /\buseFrameRenderer\b/,
    },
    {
      label: "nested ExecuTorch live-pose processor",
      pattern: /\bcreateExecutorchLivePoseProcessor\b/,
    },
    { label: "RN worklet scheduler", pattern: /\bscheduleOnRN\b/ },
    { label: "Reanimated mutable factory", pattern: /\bmakeMutable\b/ },
    {
      label: "Skia native-buffer import",
      pattern: /\bSkia\.Image\.MakeImageFromNativeBuffer\b/,
    },
    { label: "direct renderer resource disposal", pattern: /\.dispose\(\)/ },
  ];
  const failures = [];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenExamplePatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("published packages declare every package their source imports", async () => {
  const failures = [];
  const internalPackages = await listInternalWorkspacePackages();

  for (const name of publishedPackages) {
    const packageDir = path.join(rootDir, "packages", name);
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    );
    // A private workspace package is never published, so a published package
    // cannot resolve one at install time and must inline it at build time
    // instead. Declaring it would ship a manifest npm cannot satisfy.
    const declared = new Set([
      ...internalPackages,
      // A package always resolves its own name, which is how the browser
      // package reaches the engine subpath it publishes.
      manifest.name,
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const files = await listSourceFilesWithoutTests(
      path.join(packageDir, "src"),
    );

    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));

      for (const imported of importedPackages(source)) {
        if (!declared.has(imported)) {
          failures.push(
            `${path.relative(rootDir, file)} imports ${imported}, which packages/${name}/package.json does not declare`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

async function listInternalWorkspacePackages() {
  const entries = await readdir(path.join(rootDir, "packages"), {
    withFileTypes: true,
  });
  const names = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifest = JSON.parse(
      await readFile(
        path.join(rootDir, "packages", entry.name, "package.json"),
        "utf8",
      ),
    );

    if (manifest.private === true) {
      names.push(manifest.name);
    }
  }

  return names;
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function listSourceFilesWithoutTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listSourceFilesWithoutTests(entryPath);
      }

      return entry.isFile() && /(?<!\.test)\.(?:ts|tsx)$/.test(entry.name)
        ? [entryPath]
        : [];
    }),
  );

  return files.flat();
}

/**
 * A value import of the engine folds it into the browser package's main entry,
 * so a consumer who only annotates images downloads the engine's 1.5 MB
 * embedded worker to never run it. `import type` is erased before a bundler
 * sees it, and `import()` is how the package is meant to reach the engine, so
 * neither counts.
 */
function staticEngineImports(source) {
  const statements = [];

  for (const match of source.matchAll(videoEngineSpecifier)) {
    const preceding = source.slice(0, match.index);
    const keyword = Math.max(
      preceding.lastIndexOf("import"),
      preceding.lastIndexOf("export"),
    );

    if (keyword === -1) {
      continue;
    }

    const clause = preceding.slice(keyword);

    if (
      staticValueImportClause.test(clause) ||
      sideEffectImportClause.test(clause)
    ) {
      statements.push(`${clause.replaceAll(/\s+/g, " ")}${match[0]}`);
    }
  }

  return statements;
}

function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

function importedPackages(source) {
  const packages = new Set();

  for (const [, specifier] of source.matchAll(importSpecifier)) {
    if (/^[.#]/.test(specifier) || specifier.startsWith("node:")) {
      continue;
    }

    const segments = specifier.split("/");

    packages.add(
      specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0],
    );
  }

  return packages;
}
