export interface DebugLoggingOptions {
  readonly args?: unknown;
  readonly description: string;
  readonly namespace: string;
}

export interface SerializedDebugError {
  readonly code: string;
  readonly message: string;
  readonly name: string;
}

// serializeDebugError and formatDebugPrefix are defined before the run*
// helpers on purpose: the worklets Babel plugin turns worklet function
// declarations into non-hoisted assignments, and module-level worklets capture
// each other by value at module-init time.
export function serializeDebugError(error: unknown): SerializedDebugError {
  "worklet";

  let code = "";
  let message = "unknown error";
  let name = "Error";

  if (typeof error === "string") {
    message = error;
  } else if (typeof error === "object" && error !== null) {
    const record = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly name?: unknown;
    };

    if (typeof record.message === "string") {
      message = record.message;
    }

    if (typeof record.name === "string") {
      name = record.name;
    }

    if (typeof record.code === "string" || typeof record.code === "number") {
      code = `${record.code}`;
    }
  }

  return {
    code,
    message,
    name,
  };
}

function formatDebugPrefix(options: DebugLoggingOptions) {
  "worklet";

  return `[debug][${options.namespace}] ${options.description}`;
}

export function runWithDebugLogging<T>(
  options: DebugLoggingOptions,
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    console.error(formatDebugPrefix(options), {
      args: options.args,
      error: serializeDebugError(error),
    });
    throw error;
  }
}

export function runWithWorkletDebugLogging<T>(
  options: DebugLoggingOptions,
  fn: () => T,
): T {
  "worklet";

  try {
    return fn();
  } catch (error) {
    console.error(formatDebugPrefix(options), {
      args: options.args,
      error: serializeDebugError(error),
    });
    throw error;
  }
}
