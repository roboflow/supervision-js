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
  if (process.env.SUPERVISION_JS_TARBALL) {
    return path.resolve(rootDir, process.env.SUPERVISION_JS_TARBALL);
  }

  const archives = existsSync(artifactsDir)
    ? readdirSync(artifactsDir).filter((entry) =>
        /^supervision-js-.*\.tgz$/.test(entry),
      )
    : [];

  assert.equal(
    archives.length,
    1,
    `Expected exactly one supervision-js tarball in ${artifactsDir}; run "npm run package:tarball" first`,
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
        name: "supervision-js-tarball-consumer",
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

  assert.equal(manifest.name, "supervision-js");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.equal(manifest.exports["./editing"].import, "./dist/editing.js");
  assert.equal(
    manifest.exports["./render-preparation-worker"],
    "./dist/mask-preparation.worker.js",
  );
});

test("tarball ships the project license and package README", () => {
  const license = readFileSync(path.join(extractedDir, "LICENSE"), "utf8");
  const readme = readFileSync(path.join(extractedDir, "README.md"), "utf8");

  assert.match(license, /MIT License/);
  assert.equal(license, readFileSync(path.join(rootDir, "LICENSE"), "utf8"));
  assert.match(
    readme,
    /npm install supervision-js/,
    "Expected the tarball README to document npm installation",
  );
  assert.doesNotMatch(readme, /has not been published yet/);
});

test("tarball ships a self-contained render-preparation worker", () => {
  const workerPath = path.join(extractedDir, "dist/mask-preparation.worker.js");

  assert.ok(existsSync(workerPath), "Expected the worker entry in the tarball");
  assert.ok(
    existsSync(`${workerPath}.map`),
    "Expected the worker source map in the tarball",
  );

  const workerSource = readFileSync(workerPath, "utf8");
  const relativeImports = [
    ...workerSource.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    relativeImports,
    [],
    "The standalone worker must not depend on sibling chunks",
  );
  assert.match(workerSource, /addEventListener\(["']message["']/);
});

test("published browser entry embeds its default worker source", () => {
  const index = readFileSync(path.join(extractedDir, "dist/index.js"), "utf8");
  const workerSource = readFileSync(
    path.join(extractedDir, "dist/mask-preparation.worker.js"),
    "utf8",
  )
    .trimEnd()
    .replace(/\n\/\/# sourceMappingURL=[^\n]+$/, "");

  assert.match(index, /URL\.createObjectURL/);
  assert.match(index, /new Blob/);
  assert.ok(
    index.includes(JSON.stringify(workerSource)),
    "Expected the browser entry to contain the exact standalone worker source",
  );
  assert.doesNotMatch(index, /mask-preparation\.worker\.js/);
  assert.doesNotMatch(
    index,
    /__SUPERVISION_JS_EMBEDDED_MASK_PREPARATION_WORKER_SOURCE__/,
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
      "node_modules/supervision-js",
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
  assert.equal(
    lockfile.packages[
      "node_modules/supervision-js/node_modules/supervision-js-core"
    ]?.inBundle,
    true,
    "Expected supervision-js-core to install from the tarball bundle",
  );
  assert.ok(
    existsSync(
      path.join(
        consumerDir,
        "node_modules/supervision-js/node_modules/supervision-js-core/dist/index.js",
      ),
    ),
    "Expected the bundled core runtime to be installed with supervision-js",
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
        'import { createMediaSession, MediaSessionStatus } from "supervision-js";',
        'import { createAnnotationEditingEngine } from "supervision-js/editing";',
        'const workerUrl = import.meta.resolve("supervision-js/render-preparation-worker");',
        "console.log(typeof createMediaSession, MediaSessionStatus.Ready, typeof createAnnotationEditingEngine, workerUrl.endsWith('/mask-preparation.worker.js'));",
      ].join("\n"),
    ],
    consumerDir,
  );

  assert.equal(output.trim(), "function ready function true");
});

test("clean consumer builds a browser bundle that imports createMediaSession", () => {
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

  mkdirSync(path.join(consumerDir, "src"), { recursive: true });
  writeFileSync(
    path.join(consumerDir, "src/main.js"),
    [
      'import { createMediaSession } from "supervision-js";',
      'import { createMaskBrushEditor } from "supervision-js/editing";',
      "",
      "globalThis.supervisionEntrypoints = [",
      "  createMediaSession,",
      "  createMaskBrushEditor,",
      "];",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerDir, "index.html"),
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
    consumerDir,
  );

  const bundleDir = path.join(consumerDir, "dist/assets");

  assert.ok(
    readdirSync(bundleDir).some((entry) => entry.endsWith(".js")),
    "Expected the consumer build to emit JavaScript",
  );
});
