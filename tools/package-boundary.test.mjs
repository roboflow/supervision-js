import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();
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

const publishedPackages = ["core", "react-native", "web"];
const videoEngineCheckout = "roboflow-video-runtime";
const importSpecifier =
  /(?:\bfrom\s*|\bimport\s*[(\s]\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const videoEngineCheckoutPath = new RegExp(
  `"([^"]*${videoEngineCheckout}[^"]*)"`,
  "g",
);
const videoEngineSourceConfigs = ["vitest.config.ts", "demo/vite.config.ts"];
const videoEngineDeclarationConfigs = [
  "packages/web/tsconfig.json",
  "demo/tsconfig.json",
];
const videoEngineAliasConfigs = [
  ...videoEngineSourceConfigs,
  ...videoEngineDeclarationConfigs,
];
const videoEngineSourceFiles = ["index.ts", "analysis.ts"];

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

  for (const name of publishedPackages) {
    const packageDir = path.join(rootDir, "packages", name);
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, "package.json"), "utf8"),
    );
    const declared = new Set([
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

test("the video engine checkout the build resolves through is present", async () => {
  const targets = await videoEngineAliasTargets();
  const checkouts = new Set(targets.map(({ checkout }) => checkout));

  assert.equal(
    checkouts.size,
    1,
    `The video engine aliases resolve through different checkouts: ${[...checkouts].join(", ")}`,
  );

  const [checkout] = checkouts;

  assert.ok(
    existsSync(checkout),
    [
      `No video engine checkout at ${checkout}.`,
      `@roboflow/video-engine is not published, so ${videoEngineAliasConfigs.join(", ")} resolve it through that directory.`,
      'CONTRIBUTING.md, "Video Engine Checkout", says what belongs there.',
    ].join("\n"),
  );

  const declarationTargets = targets.filter(({ config }) =>
    videoEngineDeclarationConfigs.includes(config),
  );
  const missingDeclarations = declarationTargets.filter(
    ({ resolved }) => !existsSync(resolved),
  );

  assert.deepEqual(
    missingDeclarations.map(({ resolved }) =>
      path.relative(checkout, resolved),
    ),
    [],
    [
      ...missingDeclarations.map(
        ({ config, resolved }) =>
          `${config} resolves @roboflow/video-engine to ${resolved}, which is not there.`,
      ),
      "The engine emits its declarations with `npm run types:videoengine` from its `app/` directory.",
    ].join("\n"),
  );

  const sourceTargets = targets.filter(({ config }) =>
    videoEngineSourceConfigs.includes(config),
  );
  const missingSourceFiles = sourceTargets.flatMap(({ config, resolved }) =>
    videoEngineSourceFiles
      .filter((file) => !existsSync(path.join(resolved, file)))
      .map(
        (file) =>
          `${config} resolves @roboflow/video-engine into ${resolved}, but ${file} is not there.`,
      ),
  );

  assert.deepEqual(
    missingSourceFiles,
    [],
    [
      ...missingSourceFiles,
      "The checkout directory exists but is missing the engine's TypeScript source, which vitest and the demo dev server compile directly.",
    ].join("\n"),
  );
});

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

async function videoEngineAliasTargets() {
  const targets = [];

  for (const config of videoEngineAliasConfigs) {
    const configPath = path.join(rootDir, config);
    const source = stripComments(await readFile(configPath, "utf8"));
    const paths = [...source.matchAll(videoEngineCheckoutPath)].map(
      ([, value]) => value,
    );

    assert.notEqual(
      paths.length,
      0,
      `${config} spells no ${videoEngineCheckout} path, so nothing there resolves @roboflow/video-engine`,
    );

    for (const value of paths) {
      const resolved = path.resolve(path.dirname(configPath), value);
      const segments = resolved.split(path.sep);

      targets.push({
        checkout: segments
          .slice(0, segments.lastIndexOf(videoEngineCheckout) + 1)
          .join(path.sep),
        config,
        resolved,
      });
    }
  }

  return targets;
}
