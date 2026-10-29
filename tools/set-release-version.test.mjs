import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  compareVersions,
  resolveVersion,
  setReleaseVersion,
} from "./set-release-version.mjs";

const versionFiles = [
  "packages/web/package.json",
  "package-lock.json",
  "docs/public/typedoc-icons.js",
  "docs/public/guides/migrating-to-0.2.md",
];

function withRepositoryCopy(callback) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "supervision-release-"));
  try {
    for (const file of versionFiles) {
      cpSync(path.join(process.cwd(), file), path.join(rootDir, file));
    }
    return callback(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

const read = (rootDir, file) => readFileSync(path.join(rootDir, file), "utf8");

test("versions order by SemVer precedence", () => {
  assert.ok(compareVersions("0.2.10", "0.2.9") > 0);
  assert.ok(compareVersions("0.3.0", "0.2.99") > 0);
  assert.ok(compareVersions("0.3.0", "0.3.0-next.4") > 0);
  assert.ok(compareVersions("0.3.0-next.10", "0.3.0-next.9") > 0);
  assert.ok(compareVersions("0.3.0-next.0", "0.3.0-next") > 0);
  assert.equal(compareVersions("0.2.17", "0.2.17"), 0);
  assert.throws(() => compareVersions("v0.2.17", "0.2.17"), /SemVer/);
});

test("patch and minor resolve against the current version", () => {
  assert.equal(resolveVersion("patch", "0.2.17"), "0.2.18");
  assert.equal(resolveVersion("minor", "0.2.17"), "0.3.0");
  assert.equal(resolveVersion("patch", "0.3.0-next.2"), "0.3.0");
  assert.equal(resolveVersion("minor", "0.3.0-next.2"), "0.3.0");
  assert.equal(resolveVersion("0.2.20", "0.2.17"), "0.2.20");
  assert.throws(() => resolveVersion("major", "0.2.17"), /SemVer/);
});

test("a release moves every version mirror together", () => {
  withRepositoryCopy((rootDir) => {
    const current = JSON.parse(
      read(rootDir, "packages/web/package.json"),
    ).version;
    const next = resolveVersion("patch", current);

    const result = setReleaseVersion("patch", { rootDir });

    assert.equal(result.previousVersion, current);
    assert.equal(result.version, next);
    assert.deepEqual(result.changed, versionFiles);

    const manifest = JSON.parse(read(rootDir, "packages/web/package.json"));
    const lockfile = JSON.parse(read(rootDir, "package-lock.json"));
    const toolbar = read(rootDir, "docs/public/typedoc-icons.js");
    const guide = read(rootDir, "docs/public/guides/migrating-to-0.2.md");

    assert.equal(manifest.version, next);
    assert.equal(lockfile.packages["packages/web"].version, next);
    assert.match(toolbar, new RegExp(`const packageVersion = "${next}";`));
    assert.match(toolbar, /const packageReleaseStatus = "";/);
    assert.match(guide, new RegExp(`Upgrade to \`${next}\` with:`));
    assert.match(guide, new RegExp(`npm install supervision@${next}\n`));

    // Only the version lines change; every other line is kept byte for byte.
    const expectedChangedLines = [1, 1, 1, 2];
    versionFiles.forEach((file, index) => {
      const before = readFileSync(path.join(process.cwd(), file), "utf8").split(
        "\n",
      );
      const after = read(rootDir, file).split("\n");
      assert.equal(after.length, before.length, `${file} gained lines`);
      const changedLines = after.filter((line, i) => line !== before[i]);
      assert.equal(
        changedLines.length,
        expectedChangedLines[index],
        `${file} changed beyond its version`,
      );
      for (const line of changedLines) assert.ok(line.includes(next));
    });
  });
});

test("a prerelease marks the toolbar and keeps the stable install line", () => {
  withRepositoryCopy((rootDir) => {
    const guideBefore = read(rootDir, "docs/public/guides/migrating-to-0.2.md");

    const result = setReleaseVersion("0.3.0-next.0", { rootDir });

    assert.equal(result.version, "0.3.0-next.0");
    assert.match(
      read(rootDir, "docs/public/typedoc-icons.js"),
      /const packageReleaseStatus = "next preview";/,
    );
    assert.equal(
      read(rootDir, "docs/public/guides/migrating-to-0.2.md"),
      guideBefore,
    );
    assert.equal(result.skipped.length, 1);
  });
});

test("a new minor line without its migration guide still updates the rest", () => {
  withRepositoryCopy((rootDir) => {
    const result = setReleaseVersion("minor", { rootDir });

    assert.match(result.version, /^\d+\.\d+\.0$/);
    assert.equal(result.changed.length, 3);
    assert.match(result.skipped[0], /write the migration guide by hand/);
  });
});

test("a version that does not move forward is refused", () => {
  withRepositoryCopy((rootDir) => {
    const current = JSON.parse(
      read(rootDir, "packages/web/package.json"),
    ).version;

    assert.throws(
      () => setReleaseVersion(current, { rootDir }),
      /must be greater than the current version/,
    );
    assert.throws(
      () => setReleaseVersion("0.0.1", { rootDir }),
      /must be greater than the current version/,
    );
  });
});
