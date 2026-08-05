/**
 * Builds one portable `supervision-js-<version>.tgz` for consumers that cannot
 * access this private repository.
 *
 * The browser package depends on the private `supervision-js-core` workspace
 * through `file:../core`, which does not exist for an external consumer. Rather
 * than dissolving that boundary in source, this script packs both workspaces
 * with npm, stages the core archive inside the web archive's `node_modules`,
 * and marks it as a bundled dependency. Public dependencies such as `pixi.js`
 * and `mediabunny` stay ordinary registry dependencies.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const webPackageName = "supervision-js";
const corePackageName = "supervision-js-core";

function parseArgs(argv) {
  const options = { outDir: path.join(rootDir, "artifacts"), skipBuild: false };

  for (const arg of argv) {
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg.startsWith("--out-dir=")) {
      options.outDir = path.resolve(rootDir, arg.slice("--out-dir=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, shell: false, stdio: "pipe" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}\n${output}`,
    );
  }

  return String(result.stdout ?? "");
}

function runInherit(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`,
    );
  }
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function packWorkspace(workspace, destination) {
  mkdirSync(destination, { recursive: true });
  run(
    "npm",
    [
      "pack",
      "--workspace",
      workspace,
      "--pack-destination",
      destination,
      "--silent",
    ],
    rootDir,
  );

  const archives = readdirSync(destination).filter((entry) =>
    entry.endsWith(".tgz"),
  );

  if (archives.length !== 1) {
    throw new Error(
      `Expected exactly one archive for ${workspace}, found ${archives.length}`,
    );
  }

  return path.join(destination, archives[0]);
}

function extract(archivePath, destination, stripComponents) {
  mkdirSync(destination, { recursive: true });
  run("tar", [
    "-xzf",
    archivePath,
    "-C",
    destination,
    "--strip-components",
    String(stripComponents),
  ]);
}

/**
 * Rewrites the staged manifest so the private core dependency resolves from the
 * bundled copy instead of a repository-relative path.
 */
function bundleCoreDependency(stagedManifestPath, coreVersion) {
  const manifest = readManifest(stagedManifestPath);
  const dependencies = manifest.dependencies ?? {};

  if (!(corePackageName in dependencies)) {
    throw new Error(
      `${webPackageName} no longer depends on ${corePackageName}; update the packaging script`,
    );
  }

  dependencies[corePackageName] = coreVersion;
  manifest.dependencies = dependencies;
  manifest.bundleDependencies = [corePackageName];

  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec === "string" && spec.startsWith("file:")) {
      throw new Error(
        `Dependency ${name} still uses a repository-relative spec: ${spec}`,
      );
    }
  }

  writeFileSync(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function clearPreviousArchives(outDir) {
  mkdirSync(outDir, { recursive: true });

  for (const entry of readdirSync(outDir)) {
    if (/^supervision-js-.*\.tgz$/.test(entry)) {
      rmSync(path.join(outDir, entry));
    }
  }
}

function copyPackageDocuments(packageDir) {
  for (const filename of ["LICENSE", "README.md"]) {
    copyFileSync(path.join(rootDir, filename), path.join(packageDir, filename));
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.skipBuild) {
    runInherit("npm", ["run", "build", "-w", corePackageName], rootDir);
    runInherit("npm", ["run", "build", "-w", webPackageName], rootDir);
  }

  const stagingDir = mkdtempSync(path.join(tmpdir(), "supervision-js-pack-"));

  try {
    const webArchive = packWorkspace(
      webPackageName,
      path.join(stagingDir, "web"),
    );
    const coreArchive = packWorkspace(
      corePackageName,
      path.join(stagingDir, "core"),
    );

    const packageDir = path.join(stagingDir, "package");

    extract(webArchive, packageDir, 1);
    extract(
      coreArchive,
      path.join(packageDir, "node_modules", corePackageName),
      1,
    );
    copyPackageDocuments(packageDir);

    const coreManifest = readManifest(
      path.join(packageDir, "node_modules", corePackageName, "package.json"),
    );

    bundleCoreDependency(
      path.join(packageDir, "package.json"),
      coreManifest.version,
    );

    clearPreviousArchives(options.outDir);
    run(
      "npm",
      ["pack", "--pack-destination", options.outDir, "--silent"],
      packageDir,
    );

    const version = readManifest(path.join(packageDir, "package.json")).version;
    const tarballPath = path.join(
      options.outDir,
      `${webPackageName}-${version}.tgz`,
    );
    const sizeKb = Math.round(statSync(tarballPath).size / 1024);

    process.stdout.write(
      `Packed ${path.relative(rootDir, tarballPath)} (${sizeKb} kB) with ${corePackageName}@${coreManifest.version} bundled.\n`,
    );
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

main();
