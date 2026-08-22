import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const SEMVER = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const OUTPUT_FLAG = /(?:^|-)(?:out|output|dest|destination|dir)(?:-|$)/;
const PROPOSAL = /^\s*[-*]\s*(?:Add|Create|New)\b/i;
const TEMPLATE = /[<>{}*$~|?!,()[\]"'`\\]|\.\.\./;

export async function loadRepository(rootDir) {
  const ignore = parseIgnoreFile(
    await readFile(path.join(rootDir, ".gitignore"), "utf8"),
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  );
  const packages = await readWorkspacePackages(rootDir, rootManifest);
  const topLevelEntries = new Set(
    (await readdir(rootDir)).filter((entry) => entry !== ".git"),
  );

  return {
    ignore,
    packages,
    rootDir,
    rootManifest,
    topLevelEntries,
    packagesByName: new Map(
      packages.map((workspace) => [workspace.name, workspace]),
    ),
    packagesByDirectory: new Map(
      packages.map((workspace) => [workspace.directory, workspace]),
    ),
  };
}

/** Every Markdown file git would track. */
export async function loadDocuments(repository) {
  const files = await listMarkdown(repository, repository.rootDir);

  return Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");

      return {
        blocks: segment(source),
        directory: path.dirname(file),
        file,
        relative: path.relative(repository.rootDir, file),
        source,
      };
    }),
  );
}

/**
 * Class 1. A path token is a claim when it is rooted at a real top-level entry
 * of this repository, which is what separates `tools/x/y.mjs` from a module
 * specifier, a runtime URL, or a path relative to some other file the document
 * quotes. Outside code formatting the token also has to look like a file, so
 * that prose pairs such as "demo/docs changes" stay prose. Generated output,
 * destinations an earlier command in the same block writes, and files a plan
 * proposes adding are not claims about what exists.
 */
export async function checkPaths(repository, documents) {
  const failures = [];

  for (const document of documents) {
    for (const block of document.blocks) {
      const produced =
        block.kind === "fence" ? producedPaths(block.text) : new Set();

      for (const [offset, line] of block.text.split("\n").entries()) {
        if (block.kind === "text" && PROPOSAL.test(line)) {
          continue;
        }

        const quoted = new Set(
          [...line.matchAll(/`([^`]+)`/g)].flatMap((match) =>
            pathTokens(match[1]),
          ),
        );

        for (const token of pathTokens(line)) {
          if (
            produced.has(token) ||
            (block.kind === "text" &&
              !quoted.has(token) &&
              !/\.[a-z0-9]+$|\/$/i.test(token))
          ) {
            continue;
          }

          const resolved = resolveClaimedPath(repository, token);

          if (!resolved || repository.ignore(resolved.relative)) {
            continue;
          }

          if (!(await exists(resolved.absolute))) {
            failures.push(
              `${document.relative}:${block.line + offset} names missing path ${token}`,
            );
          }
        }
      }
    }
  }

  return failures;
}

/** Class 2. Every `npm run` in a document runs a script that exists. */
export async function checkNpmScripts(repository, documents) {
  const failures = [];

  for (const document of documents) {
    for (const block of document.blocks) {
      for (const invocation of npmRunInvocations(block.text)) {
        const workspace = resolveWorkspace(repository, invocation.workspace);

        if (invocation.workspace && !workspace) {
          failures.push(
            `${document.relative}:${block.line} runs a script in unknown workspace ${invocation.workspace}`,
          );
          continue;
        }

        const manifest = workspace?.manifest ?? repository.rootManifest;
        const owner = workspace ? workspace.directory : ".";

        if (!manifest.scripts?.[invocation.script]) {
          failures.push(
            `${document.relative}:${block.line} runs missing script "${invocation.script}" in ${owner}/package.json`,
          );
        }
      }
    }
  }

  return failures;
}

/**
 * Class 3. A flag shown for a repository script has to be one that script
 * reads. Flags on a command line are checked against that command's script;
 * flags quoted in prose are checked against every script the document invokes,
 * because prose does not always say which one it means.
 */
export async function checkScriptFlags(repository, documents) {
  const failures = [];

  for (const document of documents) {
    const documented = new Set();

    for (const block of document.blocks) {
      if (block.kind !== "fence") {
        continue;
      }

      for (const command of commandLines(block.text)) {
        const target = await resolveScriptTarget(repository, command);

        if (!target) {
          continue;
        }

        documented.add(target.file);

        const accepted = await acceptedFlags(target.file);

        for (const flag of command.flags) {
          if (!accepted.has(flag)) {
            failures.push(
              `${document.relative}:${block.line} passes ${flag} to ${target.relative}, which does not read it`,
            );
          }
        }
      }
    }

    if (documented.size === 0 || !isColocated(document)) {
      continue;
    }

    const accepted = new Set(
      (
        await Promise.all([...documented].map((file) => acceptedFlags(file)))
      ).flatMap((flags) => [...flags]),
    );

    for (const block of document.blocks) {
      if (block.kind === "fence") {
        continue;
      }

      for (const [, flag] of block.text.matchAll(/`(--[a-z0-9][a-z0-9-]*)`/g)) {
        if (!accepted.has(flag)) {
          failures.push(
            `${document.relative}:${block.line} documents ${flag}, which no script it invokes reads`,
          );
        }
      }
    }
  }

  return failures;
}

/**
 * Class 4. A checksum quoted beside a path is provenance: it has to be the
 * digest of that file, or a digest the file itself records. A checksum that has
 * drifted from its file is how a swapped input stays invisible.
 */
export async function checkChecksums(repository, documents) {
  const failures = [];

  for (const document of documents) {
    for (const block of document.blocks) {
      const digests = [...block.text.matchAll(/`([0-9a-f]{8,64})(\.{3})?`/g)];

      if (digests.length === 0 || !/sha-?256/i.test(block.text)) {
        continue;
      }

      const neighbours = await neighbourFiles(repository, document, block.text);

      for (const [, digest] of digests) {
        if (await matchesNeighbour(digest, neighbours)) {
          continue;
        }

        failures.push(
          `${document.relative}:${block.line} quotes sha256 ${digest} for no file it names`,
        );
      }
    }
  }

  return failures;
}

/**
 * Class 5. A version literal quoted where a package is named describes that
 * package's manifest. The claim reaches an adjacent code fence, because the
 * install command and the sentence introducing it are one claim.
 */
export async function checkVersions(repository, documents) {
  const failures = [];

  for (const document of documents) {
    for (const [index, block] of document.blocks.entries()) {
      for (const [, name, version] of block.text.matchAll(
        /\b([a-z][a-z0-9-]*(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+)\b/g,
      )) {
        const workspace = repository.packagesByName.get(name);

        if (workspace && workspace.version !== version) {
          failures.push(
            `${document.relative}:${block.line} pins ${name}@${version}, but ${workspace.directory}/package.json is ${workspace.version}`,
          );
        }
      }

      if (block.kind === "fence") {
        continue;
      }

      const scope = [
        document.blocks[index - 1],
        block,
        document.blocks[index + 1],
      ]
        .filter((entry) => entry && (entry === block || entry.kind === "fence"))
        .map((entry) => entry.text)
        .join("\n");
      const anchored = repository.packages.filter(
        (workspace) =>
          scope.includes(`\`${workspace.name}\``) ||
          scope.includes(`"${workspace.name}"`) ||
          scope.includes(`install ${workspace.name}`) ||
          scope.includes(`\`${workspace.directory}\``),
      );

      if (anchored.length === 0) {
        continue;
      }

      for (const [, literal] of block.text.matchAll(
        /`(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`/g,
      )) {
        const version = literal.match(SEMVER)[1];

        if (anchored.some((workspace) => workspace.version === version)) {
          continue;
        }

        failures.push(
          `${document.relative}:${block.line} states ${literal} beside ${anchored
            .map((workspace) => `${workspace.name}@${workspace.version}`)
            .join(", ")}`,
        );
      }
    }
  }

  return failures;
}

/**
 * Class 6. Both halves of an import are checkable: the subpath has to be in the
 * package's exports map, and each named binding has to be exported by the
 * source that subpath resolves to.
 */
export async function checkExports(repository, documents) {
  const failures = [];
  const exportCache = new Map();

  for (const document of documents) {
    for (const block of document.blocks) {
      for (const claim of moduleClaims(repository, block)) {
        const { workspace, subpath } = claim;
        const exportsMap = workspace.manifest.exports;

        if (exportsMap && !exportsMap[subpath]) {
          failures.push(
            `${document.relative}:${block.line} imports ${claim.specifier}, which ${workspace.directory}/package.json does not export`,
          );
          continue;
        }

        if (claim.names.length === 0) {
          continue;
        }

        const entry = await resolveEntrySource(workspace, subpath);

        if (!entry) {
          continue;
        }

        const exported = await readExportedNames(entry, exportCache);

        for (const name of claim.names) {
          if (!exported.has(name)) {
            failures.push(
              `${document.relative}:${block.line} imports ${name} from ${claim.specifier}, which does not export it`,
            );
          }
        }
      }
    }
  }

  return failures;
}

function segment(source) {
  const lines = source.split("\n");
  const blocks = [];
  let buffer = [];
  let bufferLine = 1;
  let fence = null;

  const flush = () => {
    if (buffer.some((line) => line.trim())) {
      blocks.push({ kind: "text", line: bufferLine, text: buffer.join("\n") });
    }

    buffer = [];
  };

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const marker = line.match(/^\s*(```+|~~~+)(.*)$/);

    if (fence) {
      if (marker && marker[1].startsWith(fence.marker[0])) {
        blocks.push({
          info: fence.info,
          kind: "fence",
          line: fence.line,
          text: fence.lines.join("\n"),
        });
        fence = null;
        bufferLine = number + 1;
        continue;
      }

      fence.lines.push(line);
      continue;
    }

    if (marker) {
      flush();
      fence = {
        info: marker[2].trim(),
        line: number,
        lines: [],
        marker: marker[1],
      };
      continue;
    }

    if (!line.trim()) {
      flush();
      bufferLine = number + 1;
      continue;
    }

    if (buffer.length === 0) {
      bufferLine = number;
    }

    buffer.push(line);
  }

  flush();

  if (fence) {
    blocks.push({
      info: fence.info,
      kind: "fence",
      line: fence.line,
      text: fence.lines.join("\n"),
    });
  }

  return blocks;
}

function pathTokens(text) {
  return [...text.matchAll(/(?<![\w./@-])([\w.@-]+(?:\/[\w.@-]+)+\/?)/g)]
    .map((match) => match[1])
    .filter((token) => !TEMPLATE.test(token));
}

function resolveClaimedPath(repository, token) {
  const trimmed = token.replace(/\/$/, "");

  if (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    !repository.topLevelEntries.has(trimmed.split("/")[0])
  ) {
    return null;
  }

  const absolute = path.resolve(repository.rootDir, trimmed);
  const relative = path.relative(repository.rootDir, absolute);

  return relative.startsWith("..")
    ? null
    : { absolute, relative: relative.split(path.sep).join("/") };
}

function producedPaths(text) {
  const produced = new Set();

  for (const command of commandLines(text)) {
    for (const [index, token] of command.tokens.entries()) {
      const flag = token.match(/^--([a-z0-9][a-z0-9-]*)(=(.*))?$/);

      if (flag && OUTPUT_FLAG.test(flag[1])) {
        produced.add(flag[3] ?? command.tokens[index + 1]);
      }

      if (token === ">" || token === ">>") {
        produced.add(command.tokens[index + 1]);
      }
    }
  }

  produced.delete(undefined);

  return produced;
}

function commandLines(text) {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((line) => line.replace(/^\s*[#$]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line
        .split(/\s+/)
        .map((token) => token.replace(/^`+/, "").replace(/`+[.,;:]*$/, ""))
        .filter((token) => token && !/^[A-Z_][A-Z0-9_]*=/.test(token));
      const separator = tokens.indexOf("--");

      return {
        flags: [
          ...new Set(
            tokens
              .slice(separator === -1 ? 0 : separator + 1)
              .map((token) => token.match(/^(--[a-z0-9][a-z0-9-]*)(=|$)/)?.[1])
              .filter(Boolean),
          ),
        ],
        line,
        separator,
        tokens,
      };
    });
}

function npmRunInvocations(text) {
  return commandLines(text).flatMap((command) => {
    const runs = [];

    for (const [index, token] of command.tokens.entries()) {
      if (token !== "run" || command.tokens[index - 1] !== "npm") {
        continue;
      }

      const script = command.tokens[index + 1];

      if (!script || !/^[\w:.-]+$/.test(script)) {
        continue;
      }

      const scoped = command.tokens.slice(
        index,
        command.separator === -1 ? undefined : command.separator,
      );
      const workspaceIndex = scoped.findIndex(
        (token) => token === "-w" || token === "--workspace",
      );
      const inline = scoped
        .find((token) => token.startsWith("--workspace="))
        ?.slice("--workspace=".length);

      runs.push({
        script,
        workspace:
          inline ?? (workspaceIndex === -1 ? null : scoped[workspaceIndex + 1]),
      });
    }

    return runs;
  });
}

function resolveWorkspace(repository, reference) {
  if (!reference) {
    return null;
  }

  return (
    repository.packagesByName.get(reference) ??
    repository.packagesByDirectory.get(reference.replace(/\/$/, "")) ??
    null
  );
}

/**
 * Follows a command to the repository script that would actually read its
 * flags, through however many `npm run` hops the manifest declares. A command
 * whose target is an external tool has no readable flag set and is skipped.
 */
async function resolveScriptTarget(repository, command, seen = new Set()) {
  const direct = command.tokens.find((token) => /\.[cm]?js$/.test(token));

  if (direct && command.tokens.includes("node")) {
    const resolved = resolveClaimedPath(repository, direct);

    return resolved && (await exists(resolved.absolute))
      ? { file: resolved.absolute, relative: resolved.relative }
      : null;
  }

  const [invocation] = npmRunInvocations(command.line);

  if (!invocation || (command.separator === -1 && seen.size === 0)) {
    return null;
  }

  const workspace = resolveWorkspace(repository, invocation.workspace);
  const manifest = workspace?.manifest ?? repository.rootManifest;
  const key = `${workspace?.directory ?? "."}#${invocation.script}`;
  const body = manifest.scripts?.[invocation.script];

  if (!body || seen.has(key)) {
    return null;
  }

  seen.add(key);

  const candidates = commandLines(body)
    .map((next) => ({ ...next, separator: 0 }))
    .filter(
      (next) =>
        next.tokens.includes("node") ||
        next.tokens.some((token) => token === "run"),
    );
  const targets = [];

  for (const candidate of candidates) {
    const target = await resolveScriptTarget(repository, candidate, seen);

    if (target) {
      targets.push(target);
    }
  }

  return targets.length === 1 ? targets[0] : null;
}

const flagCache = new Map();

async function acceptedFlags(file) {
  const cached = flagCache.get(file);

  if (cached) {
    return cached;
  }

  const source = await readFile(file, "utf8");
  const flags = new Set(
    [...source.matchAll(/--[a-z0-9][a-z0-9-]*/g)].map((match) => match[0]),
  );

  for (const name of parseArgsOptionNames(file, source)) {
    flags.add(`--${name}`);
  }

  flagCache.set(file, flags);

  return flags;
}

/** node:util parseArgs declares flags as option keys, never as `--name` text. */
function parseArgsOptionNames(file, source) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(parsed).endsWith("parseArgs")
    ) {
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) {
          continue;
        }

        for (const property of argument.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(parsed).replace(/["']/g, "") === "options" &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            for (const option of property.initializer.properties) {
              names.push(option.name.getText(parsed).replace(/["']/g, ""));
            }
          }
        }
      }
    }

    node.forEachChild(visit);
  };

  visit(parsed);

  return names;
}

function isColocated(document) {
  return document.relative.startsWith("tools/");
}

async function neighbourFiles(repository, document, text) {
  const files = [];

  for (const [, token] of text.matchAll(/`([^`\s]+)`/g)) {
    if (TEMPLATE.test(token)) {
      continue;
    }

    const rooted = resolveClaimedPath(repository, token);
    const nearby = path.resolve(document.directory, token);

    for (const candidate of [rooted?.absolute, nearby]) {
      if (candidate && (await isFile(candidate))) {
        files.push(candidate);
      }
    }
  }

  return files;
}

async function matchesNeighbour(digest, files) {
  for (const file of files) {
    const contents = await readFile(file);

    if (
      createHash("sha256").update(contents).digest("hex").startsWith(digest)
    ) {
      return true;
    }

    if (contents.includes(digest)) {
      return true;
    }
  }

  return false;
}

function moduleClaims(repository, block) {
  const claims = [];
  const record = (specifier, names) => {
    const parts = specifier.split("/");
    const name = specifier.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0];
    const workspace = repository.packagesByName.get(name);

    if (!workspace) {
      return;
    }

    if (
      names.length === 0 &&
      claims.some((claim) => claim.specifier === specifier)
    ) {
      return;
    }

    const rest = specifier.slice(name.length);

    claims.push({
      names,
      specifier,
      subpath: rest ? `.${rest}` : ".",
      workspace,
    });
  };

  if (block.kind === "fence") {
    const source = decodeEntities(block.text);

    for (const [, clause, specifier] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      record(
        specifier,
        clause
          .split(",")
          .map(
            (entry) =>
              entry
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/)[0],
          )
          .filter(Boolean),
      );
    }

    for (const [, specifier] of source.matchAll(
      /(?:^|[^{])\bfrom\s*["']([^"']+)["']/g,
    )) {
      record(specifier, []);
    }

    return claims;
  }

  for (const [, token] of block.text.matchAll(/`([\w@./-]+)`/g)) {
    record(token, []);
  }

  return claims;
}

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

async function resolveEntrySource(workspace, subpath) {
  const entry = workspace.manifest.exports?.[subpath];
  const declaration =
    typeof entry === "string" ? entry : (entry?.types ?? entry?.import);

  if (!declaration) {
    return null;
  }

  const source = path.join(
    workspace.absolute,
    declaration
      .replace(/^\.\//, "")
      .replace(/^dist\//, "src/")
      .replace(/\.d\.ts$/, ".ts")
      .replace(/\.js$/, ".ts"),
  );

  return (await isFile(source)) ? source : null;
}

async function readExportedNames(file, cache, seen = new Set()) {
  const cached = cache.get(file);

  if (cached) {
    return cached;
  }

  if (seen.has(file)) {
    return new Set();
  }

  seen.add(file);

  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  const wildcards = [];

  source.forEachChild((node) => {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          names.add(element.name.text);
        }

        return;
      }

      if (!node.exportClause && node.moduleSpecifier) {
        wildcards.push(node.moduleSpecifier.text);
      }

      return;
    }

    if (
      !ts.canHaveModifiers(node) ||
      !ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }

      return;
    }

    if (node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
  });

  for (const wildcard of wildcards) {
    if (!wildcard.startsWith(".")) {
      continue;
    }

    const resolved = await resolveRelativeSource(path.dirname(file), wildcard);

    if (resolved) {
      for (const name of await readExportedNames(resolved, cache, seen)) {
        names.add(name);
      }
    }
  }

  cache.set(file, names);

  return names;
}

async function resolveRelativeSource(directory, specifier) {
  for (const candidate of [
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}/index.ts`,
    specifier.replace(/\.js$/, ".ts"),
  ]) {
    const resolved = path.resolve(directory, candidate);

    if (await isFile(resolved)) {
      return resolved;
    }
  }

  return null;
}

async function readWorkspacePackages(rootDir, rootManifest) {
  const directories = new Set();

  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.includes("*")) {
      directories.add(pattern);
      continue;
    }

    const parent = pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "");

    for (const entry of await readdir(path.join(rootDir, parent))) {
      directories.add(`${parent}/${entry}`);
    }
  }

  const packages = [];

  for (const directory of directories) {
    const absolute = path.join(rootDir, directory);
    const manifestPath = path.join(absolute, "package.json");

    if (!(await isFile(manifestPath))) {
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    packages.push({
      absolute,
      directory,
      manifest,
      name: manifest.name,
      version: manifest.version,
    });
  }

  return packages;
}

/**
 * Generated trees are not claims: a document may name a file the build writes
 * and a clean checkout will not have. .gitignore is the repository's own
 * statement of which paths those are.
 */
function parseIgnoreFile(source) {
  const anywhere = new Set();
  const rooted = [];

  for (const line of source.split("\n")) {
    const pattern = line.trim();

    if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) {
      continue;
    }

    if (pattern.includes("*")) {
      continue;
    }

    const cleaned = pattern.replace(/\/$/, "").replace(/^\//, "");

    if (cleaned.includes("/")) {
      rooted.push(cleaned);
      continue;
    }

    anywhere.add(cleaned);
  }

  return (relative) => {
    const segments = relative.split("/");

    return (
      segments.some((segment) => anywhere.has(segment)) ||
      rooted.some(
        (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
      )
    );
  };
}

async function listMarkdown(repository, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      const relative = path
        .relative(repository.rootDir, entryPath)
        .split(path.sep)
        .join("/");

      if (entry.name === ".git" || repository.ignore(relative)) {
        return [];
      }

      if (entry.isDirectory()) {
        return listMarkdown(repository, entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    }),
  );

  return files.flat().sort();
}

async function exists(target) {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
}

async function isFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
