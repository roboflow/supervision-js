/**
 * Moves the browser package to a new release version everywhere the repository
 * records it: the `supervision` manifest, its lockfile entry, the docs toolbar
 * mirror, and the install line of the matching migration guide.
 *
 * Usage: `node tools/set-release-version.mjs <version | patch | minor>`
 *
 * The publish workflow runs this to prepare a release pull request; running it
 * locally produces the same diff. A version must move forward from the
 * manifest's current one, because npm versions are immutable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const manifestPath = "packages/web/package.json";
const lockfilePath = "package-lock.json";
const toolbarPath = "docs/public/typedoc-icons.js";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function parseVersion(version) {
  const match = semverPattern.exec(version);
  if (!match) {
    throw new Error(`"${version}" is not a SemVer version such as 0.2.18.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }

  // A release ranks above every prerelease of the same core version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }

  return 0;
}

/**
 * Resolves `patch` or `minor` against the current version; any other request
 * must already be an explicit version. While the package stays in `0.x`, a
 * minor bump is the breaking one, so there is no `major` shortcut.
 */
export function resolveVersion(request, currentVersion) {
  const current = parseVersion(currentVersion);
  const isPrerelease = current.prerelease.length > 0;

  if (request === "patch") {
    // A prerelease of x.y.z releases as x.y.z itself.
    return isPrerelease
      ? `${current.major}.${current.minor}.${current.patch}`
      : `${current.major}.${current.minor}.${current.patch + 1}`;
  }

  if (request === "minor") {
    return isPrerelease && current.patch === 0
      ? `${current.major}.${current.minor}.0`
      : `${current.major}.${current.minor + 1}.0`;
  }

  parseVersion(request);
  return request;
}

function replaceOnce(source, pattern, replacement, description) {
  let count = 0;
  const updated = source.replace(pattern, (...match) => {
    count += 1;
    return replacement(...match);
  });

  if (count !== 1) {
    throw new Error(`Expected one ${description}, found ${count}.`);
  }

  return updated;
}

function migrationGuidePath(version) {
  const { major, minor } = parseVersion(version);
  return `docs/public/guides/migrating-to-${major}.${minor}.md`;
}

export function setReleaseVersion(request, { rootDir = defaultRootDir } = {}) {
  const read = (file) => readFileSync(path.join(rootDir, file), "utf8");
  const write = (file, contents) =>
    writeFileSync(path.join(rootDir, file), contents);

  const manifest = read(manifestPath);
  const previousVersion = JSON.parse(manifest).version;
  const version = resolveVersion(request, previousVersion);

  if (compareVersions(version, previousVersion) <= 0) {
    throw new Error(
      `${version} must be greater than the current version ${previousVersion}.`,
    );
  }

  const changed = [];

  write(
    manifestPath,
    replaceOnce(
      manifest,
      /^( {2}"version": ")[^"]+(",)$/m,
      (_, before, after) => `${before}${version}${after}`,
      `top-level version in ${manifestPath}`,
    ),
  );
  changed.push(manifestPath);

  write(
    lockfilePath,
    replaceOnce(
      read(lockfilePath),
      /("packages\/web": \{\s+"name": "supervision",\s+"version": ")[^"]+(")/,
      (_, before, after) => `${before}${version}${after}`,
      `packages/web entry in ${lockfilePath}`,
    ),
  );
  changed.push(lockfilePath);

  const releaseStatus = version.includes("-next.") ? "next preview" : "";
  let toolbar = replaceOnce(
    read(toolbarPath),
    /(const packageVersion = ")[^"]*(";)/,
    (_, before, after) => `${before}${version}${after}`,
    `packageVersion in ${toolbarPath}`,
  );
  toolbar = replaceOnce(
    toolbar,
    /(const packageReleaseStatus = ")[^"]*(";)/,
    (_, before, after) => `${before}${releaseStatus}${after}`,
    `packageReleaseStatus in ${toolbarPath}`,
  );
  write(toolbarPath, toolbar);
  changed.push(toolbarPath);

  // The guide's install line tells consumers which stable version to take, so
  // a prerelease leaves it alone. A new minor line needs a guide written by
  // hand; the release cannot invent its migration notes.
  const guidePath = migrationGuidePath(version);
  const skipped = [];
  if (parseVersion(version).prerelease.length > 0) {
    skipped.push(`${guidePath} (prereleases keep the stable install line)`);
  } else if (!existsSync(path.join(rootDir, guidePath))) {
    skipped.push(`${guidePath} (missing; write the migration guide by hand)`);
  } else {
    let guide = replaceOnce(
      read(guidePath),
      /(Upgrade to `)[^`]+(` with:)/,
      (_, before, after) => `${before}${version}${after}`,
      `"Upgrade to" line in ${guidePath}`,
    );
    guide = replaceOnce(
      guide,
      /(npm install supervision@)\S+/,
      (_, before) => `${before}${version}`,
      `npm install line in ${guidePath}`,
    );
    write(guidePath, guide);
    changed.push(guidePath);
  }

  return { previousVersion, version, changed, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [request, ...rest] = process.argv.slice(2);
  if (!request || rest.length > 0) {
    console.error(
      "Usage: node tools/set-release-version.mjs <version | patch | minor>",
    );
    process.exit(1);
  }

  try {
    const result = setReleaseVersion(request);
    console.log(
      `supervision ${result.previousVersion} -> ${result.version}\n` +
        result.changed.map((file) => `  updated ${file}`).join("\n") +
        result.skipped.map((file) => `\n  skipped ${file}`).join(""),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
