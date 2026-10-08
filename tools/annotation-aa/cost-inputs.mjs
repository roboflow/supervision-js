import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const files = (root, paths, globs) =>
  execFileSync(
    "rg",
    ["--files", "--follow", "--no-ignore", ...paths, ...globs],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
const hashes = (root, paths) =>
  Object.fromEntries(
    paths.map((path) => [path, digest(readFileSync(resolve(root, path)))]),
  );

export function pinCostInputs(
  root,
  expectedHead,
  noteFiles,
  { allowDirty = false } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? ""))
    throw Error("AA_HEAD must pin a full committed head");
  if (git(root, "rev-parse", "HEAD") !== expectedHead)
    throw Error("committed head differs from AA_HEAD");
  const dirty = git(root, "status", "--porcelain", "--untracked-files=normal");
  if (dirty && !allowDirty)
    throw Error("measurement requires a clean committed checkout");
  const trackedSourcePaths = git(root, "ls-files")
    .split("\n")
    .filter((path) =>
      /^(?:packages\/[^/]+\/(?:src\/|package\.json$|rollup\.config\.|tsconfig)|demo\/src\/|tools\/annotation-aa\/|(?:package(?:-lock)?\.json|eslint\.config\.js)$)/.test(
        path,
      ),
    );
  const missingSourcePaths = trackedSourcePaths.filter(
    (path) => !existsSync(resolve(root, path)),
  );
  const sourceHashes = hashes(
    root,
    trackedSourcePaths.filter((path) => existsSync(resolve(root, path))),
  );
  const compiledHashes = hashes(
    root,
    files(
      root,
      ["packages/web/dist", "packages/core/dist", "packages/trackers/dist"],
      ["-g", "*.js"],
    ),
  );
  const dependencyHashes = hashes(root, [
    "node_modules/pixi.js/package.json",
    ...files(root, ["node_modules/pixi.js/lib"], ["-g", "*.mjs"]),
  ]);
  const fixtureHashes = hashes(
    root,
    files(root, ["demo/fixtures/horse_trail"], []),
  );
  const notesHashes = hashes("/", noteFiles);
  const snapshot = {
    head: expectedHead,
    dirty,
    missingSourcePaths,
    sourceHashes,
    compiledHashes,
    dependencyHashes,
    fixtureHashes,
    notesHashes,
    sourceFingerprint: digest(JSON.stringify(sourceHashes)),
    compiledFingerprint: digest(JSON.stringify(compiledHashes)),
    dependencyFingerprint: digest(JSON.stringify(dependencyHashes)),
    fixtureFingerprint: digest(JSON.stringify(fixtureHashes)),
    buildBasis:
      "Existing compiled package bytes are pinned. The owner must finish the build before running; this driver does not compile or independently certify a prior build.",
  };
  const validate = () => {
    if (
      git(root, "rev-parse", "HEAD") !== expectedHead ||
      git(root, "status", "--porcelain", "--untracked-files=normal")
    )
      throw Error(
        "head changed or tracked/untracked work appeared during the comparison",
      );
    for (const [path, value] of Object.entries({
      ...sourceHashes,
      ...compiledHashes,
      ...dependencyHashes,
      ...fixtureHashes,
    }))
      if (digest(readFileSync(resolve(root, path))) !== value)
        throw Error(`measured input changed: ${path}`);
    for (const [path, value] of Object.entries(notesHashes))
      if (digest(readFileSync(path)) !== value)
        throw Error(`historical protocol input changed: ${path}`);
  };
  return { snapshot, validate };
}
