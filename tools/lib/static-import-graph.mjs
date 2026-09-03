import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * An emitted chunk opens a line with the keyword for each static edge, so a
 * line that starts elsewhere carries a value expression. `import()` is the seam
 * the package splits its heavy chunks at, and a lazily loaded chunk is no part
 * of what evaluating the entry pulls in.
 */
const staticBindingImport =
  /^(?:import|export)\b(?!\s*\()[^\n]*?\bfrom\s*["']([^"'\n]+)["'];?$/gm;
const staticSideEffectImport = /^import\s+["']([^"'\n]+)["'];?$/gm;

/**
 * A brace list that opens without closing on its own line belongs to a
 * statement the line-anchored patterns above cannot read. Emitted chunks keep
 * each binding statement on one line today, so this never fires; if that ever
 * changes the walk would drop those edges and report a boundary as intact
 * because it stopped looking, which is the one failure this file must not have.
 */
const wrappedBindingList = /^(?:import|export)\s*\{[^}]*$/gm;

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

    for (const specifier of staticImportSpecifiers(source, file)) {
      if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }

  return files;
}

export function staticImportSpecifiers(source, label = "an emitted chunk") {
  const wrapped = source.match(wrappedBindingList);

  if (wrapped !== null) {
    throw new Error(
      `${label} wraps a binding list across lines, which this walk cannot follow: ${wrapped[0].trim()}`,
    );
  }

  return [
    ...[...source.matchAll(staticBindingImport)],
    ...[...source.matchAll(staticSideEffectImport)],
  ].map(([, specifier]) => specifier);
}
