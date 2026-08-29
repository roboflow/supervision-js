/**
 * Verifies the packaged browser tarball from outside the monorepo.
 *
 * `package-smoke.test.mjs` checks built output through workspace resolution.
 * This suite checks the artifact a website actually installs: the archive
 * contents, and a clean npm consumer created in the OS temp directory that has
 * no access to this repository.
 *
 * Requires `npm run package:tarball` to have produced the archive, and network
 * or a warm npm cache for the public dependencies.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifactsDir = path.join(rootDir, "artifacts");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, shell: false, stdio: "pipe" });

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}\n${output}`,
    );
  }

  return String(result.stdout ?? "");
}

function resolveTarballPath() {
  if (process.env.SUPERVISION_TARBALL) {
    return path.resolve(rootDir, process.env.SUPERVISION_TARBALL);
  }

  const archives = existsSync(artifactsDir)
    ? readdirSync(artifactsDir).filter((entry) =>
        /^supervision-.*\.tgz$/.test(entry),
      )
    : [];

  assert.equal(
    archives.length,
    1,
    `Expected exactly one supervision tarball in ${artifactsDir}; run "npm run package:tarball" first`,
  );

  return path.join(artifactsDir, archives[0]);
}

const tarballPath = resolveTarballPath();

let extractedDir;
let consumerDir;

before(() => {
  extractedDir = mkdtempSync(path.join(tmpdir(), "supervision-js-extract-"));
  run("tar", [
    "-xzf",
    tarballPath,
    "-C",
    extractedDir,
    "--strip-components",
    "1",
  ]);

  consumerDir = mkdtempSync(path.join(tmpdir(), "supervision-js-consumer-"));
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "supervision-tarball-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  // The consumer lives outside the repo, so it does not inherit the repo-local
  // .npmrc that disables the release-age window for fresh dependencies.
  writeFileSync(path.join(consumerDir, ".npmrc"), "min-release-age=0\n");
  run("npm", ["install", tarballPath, "--no-audit", "--no-fund"], consumerDir);
});

after(() => {
  for (const directory of [extractedDir, consumerDir]) {
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("tarball ships both entrypoints with declarations and source maps", () => {
  for (const entry of [
    "dist/index.js",
    "dist/index.js.map",
    "dist/index.d.ts",
    "dist/editing.js",
    "dist/editing.js.map",
    "dist/editing.d.ts",
  ]) {
    assert.ok(
      existsSync(path.join(extractedDir, entry)),
      `Expected ${entry} in the tarball`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(path.join(extractedDir, "package.json"), "utf8"),
  );

  assert.equal(manifest.name, "supervision");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.equal(manifest.exports["./editing"].import, "./dist/editing.js");
  assert.equal(
    manifest.exports["./render-preparation-worker"],
    "./dist/mask-preparation.worker.js",
  );
  assert.equal(
    manifest.exports["./detection-post-processing-worker"],
    "./dist/tracking.worker.js",
  );
});

test("tarball ships the video engine as its own lazily loaded subpath", () => {
  for (const entry of [
    "dist/web-video-engine/index.js",
    "dist/web-video-engine/index.d.ts",
    "dist/web-video-engine/engine.js",
    "dist/web-video-engine/engine.d.ts",
    "dist/web-video-engine/analysis.js",
    "dist/web-video-engine/analysis.d.ts",
    "dist/web-video-engine/engine.worker.js",
  ]) {
    assert.ok(
      existsSync(path.join(extractedDir, entry)),
      `Expected ${entry} in the tarball`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(path.join(extractedDir, "package.json"), "utf8"),
  );

  assert.equal(
    manifest.exports["./web-video-engine"].import,
    "./dist/web-video-engine/index.js",
  );
  assert.equal(
    manifest.exports["./web-video-engine/analysis"].import,
    "./dist/web-video-engine/analysis.js",
  );
  assert.equal(
    manifest.exports["./web-video-engine/worker"],
    "./dist/web-video-engine/engine.worker.js",
  );
  assert.equal(
    manifest.devDependencies?.["supervision-js-web-video-engine"],
    undefined,
    "The engine's repository-relative build dependency must not reach npm",
  );

  // The engine embeds a 1.5 MB decode worker. The main entry reaches it through
  // a dynamic import, so a consumer who only annotates images never loads it.
  const index = readFileSync(path.join(extractedDir, "dist/index.js"), "utf8");

  assert.match(index, /import\(['"]\.\/web-video-engine\/engine\.js['"]\)/);
  assert.deepEqual(
    [
      ...index.matchAll(
        /^(?:import|export)[^\n]*?['"][^'"\n]*web-video-engine[^'"\n]*['"]/gm,
      ),
    ].map((match) => match[0]),
    [],
    "The main entry must not statically reach the engine",
  );

  // Every specifier the published engine entries use is relative, so a resolver
  // that supports nothing else can still read them.
  const barrel = readFileSync(
    path.join(extractedDir, "dist/web-video-engine/index.js"),
    "utf8",
  );

  assert.match(barrel, /from ['"]\.\/engine\.js['"]/);
  assert.match(barrel, /createVideoEngineMediaRendererSource/);
  assert.match(barrel, /from ['"]\.\.\/index\.js['"]/);
});

test("tarball ships the project license and package README", () => {
  const license = readFileSync(path.join(extractedDir, "LICENSE"), "utf8");
  const readme = readFileSync(path.join(extractedDir, "README.md"), "utf8");

  assert.match(license, /MIT License/);
  assert.equal(license, readFileSync(path.join(rootDir, "LICENSE"), "utf8"));
  assert.match(
    readme,
    /npm install supervision/,
    "Expected the tarball README to document npm installation",
  );
  assert.doesNotMatch(readme, /has not been published yet/);
});

test("tarball ships self-contained worker assets", () => {
  for (const workerFile of [
    "mask-preparation.worker.js",
    "tracking.worker.js",
  ]) {
    const workerPath = path.join(extractedDir, "dist", workerFile);
    assert.ok(existsSync(workerPath), `Expected ${workerFile} in the tarball`);
    assert.ok(existsSync(`${workerPath}.map`), `Expected ${workerFile}.map`);
    const workerSource = readFileSync(workerPath, "utf8");
    const relativeImports = [
      ...workerSource.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g),
    ].map((match) => match[1]);

    assert.deepEqual(relativeImports, [], `${workerFile} imports a sibling`);
    assert.match(workerSource, /addEventListener\(["']message["']/);
  }
});

test("published browser entry embeds its default worker sources", () => {
  const index = readFileSync(path.join(extractedDir, "dist/index.js"), "utf8");

  assert.match(index, /URL\.createObjectURL/);
  assert.match(index, /new Blob/);
  for (const workerFile of [
    "mask-preparation.worker.js",
    "tracking.worker.js",
  ]) {
    const workerSource = readFileSync(
      path.join(extractedDir, "dist", workerFile),
      "utf8",
    )
      .trimEnd()
      .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");
    assert.ok(
      index.includes(JSON.stringify(workerSource)),
      `Missing ${workerFile}`,
    );
  }
  assert.doesNotMatch(index, /mask-preparation\.worker\.js/);
  assert.doesNotMatch(index, /tracking\.worker\.js/);
  assert.doesNotMatch(
    index,
    /__SUPERVISION_JS_EMBEDDED_MASK_PREPARATION_WORKER_SOURCE__/,
  );
  assert.doesNotMatch(
    index,
    /__SUPERVISION_JS_EMBEDDED_TRACKING_WORKER_SOURCE__/,
  );
});

test("tarball bundles the private core package only", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(extractedDir, "package.json"), "utf8"),
  );

  assert.deepEqual(manifest.bundleDependencies, ["supervision-js-core"]);
  assert.ok(
    !manifest.dependencies["supervision-js-core"].startsWith("file:"),
    "The bundled core dependency must not use a repository-relative spec",
  );
  assert.ok(
    existsSync(
      path.join(extractedDir, "node_modules/supervision-js-core/dist/index.js"),
    ),
    "Expected the bundled core runtime in the tarball",
  );
  const corePackageDir = path.join(
    extractedDir,
    "node_modules/supervision-js-core",
  );
  const coreManifest = JSON.parse(
    readFileSync(path.join(corePackageDir, "package.json"), "utf8"),
  );
  const coreRuntime = readFileSync(
    path.join(corePackageDir, "dist/index.js"),
    "utf8",
  );

  assert.ok(
    !("supervision-js-trackers" in (coreManifest.dependencies ?? {})),
    "The internal tracker workspace must not become a runtime dependency",
  );
  assert.ok(
    !("supervision-js-trackers" in (coreManifest.devDependencies ?? {})),
    "The packaged core manifest must not expose monorepo-only build dependencies",
  );
  assert.doesNotMatch(
    coreRuntime,
    /supervision-js-trackers/,
    "Tracker engines must be bundled into the private core runtime",
  );

  // Public dependencies stay ordinary npm dependencies.
  for (const dependency of ["pixi.js", "mediabunny"]) {
    assert.ok(
      dependency in manifest.dependencies,
      `Expected ${dependency} to remain a declared dependency`,
    );
    assert.ok(
      !existsSync(path.join(extractedDir, "node_modules", dependency)),
      `${dependency} must not be bundled into the tarball`,
    );
  }
});

test("clean consumer installs the tarball without the repository", () => {
  const lockfile = JSON.parse(
    readFileSync(path.join(consumerDir, "package-lock.json"), "utf8"),
  );

  // Installing a local archive legitimately records a file: spec for the
  // archive itself. Nothing else may resolve to a path on disk, and nothing
  // may point back into this repository's workspaces.
  for (const [location, entry] of Object.entries(lockfile.packages)) {
    const resolved = entry.resolved ?? "";

    if (!resolved.startsWith("file:")) {
      continue;
    }

    assert.equal(
      location,
      "node_modules/supervision",
      `Unexpected on-disk dependency ${location} resolved from ${resolved}`,
    );
    assert.ok(
      resolved.endsWith(path.basename(tarballPath)),
      `Expected ${location} to resolve from the tarball, got ${resolved}`,
    );
  }

  assert.ok(
    !JSON.stringify(lockfile).includes("packages/core"),
    "The consumer lockfile must not reference the private core workspace",
  );
  assert.ok(
    !JSON.stringify(lockfile).includes("supervision-js-trackers"),
    "The consumer must not resolve the internal tracker workspace",
  );
  assert.equal(
    lockfile.packages[
      "node_modules/supervision/node_modules/supervision-js-core"
    ]?.inBundle,
    true,
    "Expected supervision-js-core to install from the tarball bundle",
  );
  assert.ok(
    existsSync(
      path.join(
        consumerDir,
        "node_modules/supervision/node_modules/supervision-js-core/dist/index.js",
      ),
    ),
    "Expected the bundled core runtime to be installed with supervision",
  );

  for (const dependency of ["pixi.js", "mediabunny"]) {
    const entry = lockfile.packages[`node_modules/${dependency}`];

    assert.ok(
      entry?.resolved.startsWith("https://"),
      `Expected ${dependency} to install from the registry`,
    );
    assert.ok(
      existsSync(path.join(consumerDir, "node_modules", dependency)),
      `Expected ${dependency} to be present in the consumer`,
    );
  }
});

test("clean consumer resolves package entrypoints and the standalone worker", () => {
  const output = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { createMediaSession, MediaSessionStatus } from "supervision";',
        'import { createAnnotationEditingEngine } from "supervision/editing";',
        'const workerUrl = import.meta.resolve("supervision/render-preparation-worker");',
        'const trackingWorkerUrl = import.meta.resolve("supervision/detection-post-processing-worker");',
        "console.log(typeof createMediaSession, MediaSessionStatus.Ready, typeof createAnnotationEditingEngine, workerUrl.endsWith('/mask-preparation.worker.js'), trackingWorkerUrl.endsWith('/tracking.worker.js'));",
      ].join("\n"),
    ],
    consumerDir,
  );

  assert.equal(output.trim(), "function ready function true true");
});

test("clean consumer resolves the three video engine subpaths", () => {
  const output = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'const { VideoEngine, VideoEngineErrorCode } = await import("supervision/web-video-engine");',
        'const { AnalysisSession } = await import("supervision/web-video-engine/analysis");',
        'const workerUrl = import.meta.resolve("supervision/web-video-engine/worker");',
        "console.log(typeof VideoEngine, typeof AnalysisSession, VideoEngineErrorCode.NoVideoTrack, workerUrl.endsWith('/web-video-engine/engine.worker.js'));",
      ].join("\n"),
    ],
    consumerDir,
  );

  assert.equal(output.trim(), "function function NO_VIDEO_TRACK true");
});

/**
 * Builds a throwaway Vite app against the installed tarball and returns the
 * JavaScript it emitted.
 */
function buildConsumerApp(name, entrySource) {
  const appDir = path.join(consumerDir, name);

  mkdirSync(path.join(appDir, "src"), { recursive: true });
  writeFileSync(
    path.join(appDir, "src/main.js"),
    `${entrySource.join("\n")}\n`,
  );
  writeFileSync(
    path.join(appDir, "index.html"),
    '<!doctype html>\n<html>\n  <body>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n',
  );

  run(
    process.execPath,
    [
      path.join(consumerDir, "node_modules/vite/bin/vite.js"),
      "build",
      "--logLevel",
      "error",
    ],
    appDir,
  );

  const bundleDir = path.join(appDir, "dist/assets");

  return readdirSync(bundleDir)
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => ({
      bytes: statSync(path.join(bundleDir, entry)).size,
      name: entry,
      source: readFileSync(path.join(bundleDir, entry), "utf8"),
    }));
}

/**
 * A bundler names and minifies chunks as it pleases, so the engine is found by
 * an export only it provides. Names survive minification; a chunk filename and
 * the worker's own source text do not.
 */
function engineAssets(assets) {
  return assets.filter((asset) =>
    asset.source.includes("displayBoxResolution"),
  );
}

test("a consumer that never opens a video source does not bundle the engine", () => {
  const rootManifest = JSON.parse(
    readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );

  run(
    "npm",
    [
      "install",
      `vite@${rootManifest.devDependencies.vite}`,
      "--no-audit",
      "--no-fund",
    ],
    consumerDir,
  );

  const annotatesImages = buildConsumerApp("app-images", [
    'import { createMediaSession } from "supervision";',
    'import { createMaskBrushEditor } from "supervision/editing";',
    "",
    "globalThis.supervisionEntrypoints = [createMediaSession, createMaskBrushEditor];",
  ]);
  const opensVideo = buildConsumerApp("app-video", [
    'import { createMediaSession } from "supervision";',
    'import { createVideoEngineMediaRendererSource } from "supervision/web-video-engine";',
    "",
    "globalThis.supervisionEntrypoints = [createMediaSession, createVideoEngineMediaRendererSource];",
  ]);

  assert.ok(
    annotatesImages.length > 0,
    "Expected the build to emit JavaScript",
  );
  assert.deepEqual(
    engineAssets(annotatesImages).map((asset) => asset.name),
    [],
    "The engine must be unreachable from an entry that never opens a video source",
  );

  // Reaching the engine must split it out rather than fold it into the entry:
  // its embedded decode worker alone is over a megabyte.
  const carried = engineAssets(opensVideo);

  assert.ok(carried.length > 0, "Expected the engine in a build that uses it");
  assert.ok(
    carried.some((asset) => asset.bytes > 1_000_000),
    `Expected a chunk carrying the embedded worker, saw ${carried.map((asset) => asset.bytes).join(", ")}`,
  );
  assert.ok(
    annotatesImages.every((asset) => asset.bytes < 1_000_000),
    "No chunk of an image-only build may be the size of the decode worker",
  );
});
