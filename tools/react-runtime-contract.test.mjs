import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();

test("workspace lockfile resolves React and ReactDOM to the same runtime", async () => {
  const [manifestSource, lockfileSource] = await Promise.all([
    readFile(path.join(rootDir, "package.json"), "utf8"),
    readFile(path.join(rootDir, "package-lock.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const lockfile = JSON.parse(lockfileSource);
  const expectedVersion = manifest.overrides?.react;

  assert.equal(expectedVersion, manifest.overrides?.["react-dom"]);
  assert.equal(
    lockfile.packages?.["node_modules/react"]?.version,
    expectedVersion,
  );
  assert.equal(
    lockfile.packages?.["node_modules/react-dom"]?.version,
    expectedVersion,
  );
});
