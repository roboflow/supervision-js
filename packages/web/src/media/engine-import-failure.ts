export const VIDEO_ENGINE_PACKAGE = "supervision-js-web-video-engine";
export const VIDEO_ENGINE_ANALYSIS_ENTRY = `${VIDEO_ENGINE_PACKAGE}/analysis`;

const MISSING_MODULE_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);
const MISSING_MODULE_MESSAGE =
  /cannot find (?:module|package)|failed to (?:resolve|fetch dynamically imported) module|could not resolve/i;
const QUOTED_SPECIFIER = /['"]([^'"]+)['"]/;
const MAX_WRAPPED_ERROR_DEPTH = 8;

/**
 * The engine is an optional peer, so the common reason its import fails is that
 * nobody installed it, and the raw failure names a package the caller has never
 * heard of.
 */
export function rethrowEngineImportFailure(
  error: unknown,
  entry: string,
): never {
  if (isEngineResolutionFailure(error)) {
    throw new Error(
      `openVideoEngineMediaSource needs "${entry}", which did not resolve. ` +
        `${VIDEO_ENGINE_PACKAGE} is an optional peer dependency of supervision ` +
        `and is not installed with it: run "npm install ${VIDEO_ENGINE_PACKAGE}".`,
      { cause: error },
    );
  }

  throw error;
}

/**
 * A missing engine and an engine that loaded and then threw arrive at the same
 * catch, and only the first is answered by installing the package. Loaders that
 * wrap what they caught put the resolution failure under the error they raise,
 * so the whole cause chain is read, bounded because a chain can be cyclic.
 */
export function isEngineResolutionFailure(error: unknown): boolean {
  let cursor = error;

  for (let depth = 0; depth <= MAX_WRAPPED_ERROR_DEPTH; depth += 1) {
    if (!(cursor instanceof Error)) return false;
    if (namesUnresolvedEngine(cursor)) return true;
    cursor = cursor.cause;
  }

  return false;
}

/**
 * Node and bundlers quote the specifier they failed to resolve, so a dependency
 * missing from an engine that is installed is told apart by whose name is
 * quoted; a browser reports an unquoted URL, which carries the package name too.
 *
 * Each bundler words this differently and one of them stubs the import with an
 * error of its own, so the wording is matched as well as the code. A build that
 * names the engine first and its importer second is the engine failing to
 * resolve; one that names a dependency first is that dependency's problem, and
 * reading only the first quoted specifier keeps the two apart.
 */
function namesUnresolvedEngine(error: Error): boolean {
  const code = "code" in error ? String(error.code) : "";
  if (
    !MISSING_MODULE_ERROR_CODES.has(code) &&
    !MISSING_MODULE_MESSAGE.test(error.message)
  ) {
    return false;
  }

  const quoted = QUOTED_SPECIFIER.exec(error.message)?.[1];
  return (quoted ?? error.message).includes(VIDEO_ENGINE_PACKAGE);
}
