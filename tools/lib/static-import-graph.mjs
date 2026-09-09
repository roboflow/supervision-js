import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseAst } from "rollup/parseAst";

/**
 * The three declaration forms that can name another file, which an entry
 * evaluates the moment it is named. `import()` is an expression, never one of these, which
 * is the seam the package splits its heavy chunks at: a lazily loaded chunk is
 * no part of what evaluating the entry pulls in.
 */
const STATIC_IMPORT_TYPES = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
]);

/**
 * Returns every file the relative static imports of an emitted entry lead to,
 * source keyed by absolute path. A specifier that names no file throws: a graph
 * that stopped early proves nothing about what the entry pulls in.
 */
export async function readStaticImportGraph(entryFile) {
  const files = new Map();
  const pending = [path.resolve(entryFile)];

  while (pending.length > 0) {
    const file = pending.pop();

    if (files.has(file)) {
      continue;
    }

    const source = await readFile(file, "utf8");

    files.set(file, source);

    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }

  return files;
}

export function staticImportSpecifiers(source) {
  return parseAst(source)
    .body.filter((node) => STATIC_IMPORT_TYPES.has(node.type) && node.source)
    .map((node) => node.source.value);
}
