export const VIDEO_ENGINE_ENTRY = "supervision/web-video-engine";
export const VIDEO_ENGINE_ANALYSIS_ENTRY = `${VIDEO_ENGINE_ENTRY}/analysis`;

/**
 * A bundler renames the engine chunk after the module it was split from, and a
 * browser reports the failing chunk's URL rather than the specifier that asked
 * for it, so the name a failure can be recognised by is the module's, not the
 * entry's.
 */
const VIDEO_ENGINE_MODULE = "web-video-engine";
const MISSING_MODULE_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);
const MISSING_MODULE_MESSAGE =
  /cannot find (?:module|package)|failed to (?:resolve|fetch dynamically imported) module|could not resolve/i;
const QUOTED_SPECIFIER = /['"]([^'"]+)['"]/;
const MAX_WRAPPED_ERROR_DEPTH = 8;

/**
 * The engine is a chunk of this package that the browser fetches on demand, so
 * the raw failure names a URL nobody wrote and reads like a bug in the caller's
 * own code.
 */
export function rethrowEngineImportFailure(
  error: unknown,
  entry: string,
): never {
  if (isEngineResolutionFailure(error)) {
    throw new Error(
      `openVideoEngineMediaSource needs "${entry}", which did not load. ` +
        "The video engine is a lazily loaded chunk of supervision, so check " +
        "that the deployed build still serves every chunk it emitted.",
      { cause: error },
    );
  }

  throw error;
}

/**
 * An engine that never loaded and an engine that loaded and then threw arrive
 * at the same catch, and only the first is a deployment problem. Loaders that
 * wrap what they caught put the load failure under the error they raise, so the
 * whole cause chain is read, bounded because a chain can be cyclic.
 */
export function isEngineResolutionFailure(error: unknown): boolean {
  let cursor = error;

  for (let depth = 0; depth <= MAX_WRAPPED_ERROR_DEPTH; depth += 1) {
    if (!(cursor instanceof Error)) return false;
    if (namesUnloadableEngine(cursor)) return true;
    cursor = cursor.cause;
  }

  return false;
}

/**
 * Node and bundlers quote the specifier they failed to resolve, so a dependency
 * missing from an engine that did load is told apart by whose name is quoted; a
 * browser reports an unquoted URL, which carries the chunk name too.
 *
 * Each bundler words this differently and one of them stubs the import with an
 * error of its own, so the wording is matched as well as the code. A build that
 * names the engine first and its importer second is the engine failing to load;
 * one that names a dependency first is that dependency's problem, and reading
 * only the first quoted specifier keeps the two apart.
 */
function namesUnloadableEngine(error: Error): boolean {
  const code = "code" in error ? String(error.code) : "";
  if (
    !MISSING_MODULE_ERROR_CODES.has(code) &&
    !MISSING_MODULE_MESSAGE.test(error.message)
  ) {
    return false;
  }

  const quoted = QUOTED_SPECIFIER.exec(error.message)?.[1];
  return (quoted ?? error.message).includes(VIDEO_ENGINE_MODULE);
}
