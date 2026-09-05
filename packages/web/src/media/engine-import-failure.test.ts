import { describe, expect, it } from "vitest";

import {
  isEngineResolutionFailure,
  rethrowEngineImportFailure,
  VIDEO_ENGINE_ANALYSIS_ENTRY,
  VIDEO_ENGINE_ENTRY,
} from "./engine-import-failure";

function nodeNotFound(specifier: string): Error {
  const error = new Error(
    `Cannot find package '${specifier}' imported from /app/node_modules/supervision/dist/index.js`,
  );
  Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
  return error;
}

describe("engine import failure", () => {
  it("says the engine ships with supervision when its chunk does not load", () => {
    expect(() =>
      rethrowEngineImportFailure(
        nodeNotFound(VIDEO_ENGINE_ENTRY),
        VIDEO_ENGINE_ENTRY,
      ),
    ).toThrow(
      /openWebVideoEngineMediaSource needs "supervision\/web-video-engine".*lazily loaded chunk of supervision/s,
    );
  });

  it("names the entry the caller reached for", () => {
    expect(() =>
      rethrowEngineImportFailure(
        nodeNotFound(VIDEO_ENGINE_ANALYSIS_ENTRY),
        VIDEO_ENGINE_ANALYSIS_ENTRY,
      ),
    ).toThrow(/needs "supervision\/web-video-engine\/analysis"/);
  });

  it("keeps the original failure as the cause", () => {
    const original = nodeNotFound(VIDEO_ENGINE_ENTRY);

    try {
      rethrowEngineImportFailure(original, VIDEO_ENGINE_ENTRY);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(original);
    }
  });

  it("passes through an engine that loaded and then threw", () => {
    const thrown = new Error("WebCodecs is unavailable in this browser.");

    expect(() =>
      rethrowEngineImportFailure(thrown, VIDEO_ENGINE_ENTRY),
    ).toThrow(thrown);
  });

  it("blames the package the loader actually failed to find", () => {
    // The engine loaded; something it depends on is missing. The engine's name
    // is in the importer path, so only the quoted specifier settles it.
    expect(isEngineResolutionFailure(nodeNotFound("mediabunny"))).toBe(false);
  });

  it("reads the stub a bundler builds in place of a missing chunk", () => {
    expect(() =>
      rethrowEngineImportFailure(
        new Error(
          'Could not resolve "supervision/web-video-engine" imported by ' +
            '"supervision". Is it installed?',
        ),
        VIDEO_ENGINE_ENTRY,
      ),
    ).toThrow(/lazily loaded chunk of supervision/);
  });

  it("blames a dependency the engine itself could not resolve", () => {
    const thrown = new Error(
      'Could not resolve "mediabunny" imported by ' +
        '"supervision/web-video-engine". Is it installed?',
    );

    expect(() =>
      rethrowEngineImportFailure(thrown, VIDEO_ENGINE_ENTRY),
    ).toThrow(thrown);
  });

  it("reads a browser failure, which names a hashed chunk and no specifier", () => {
    expect(
      isEngineResolutionFailure(
        new Error(
          "Failed to fetch dynamically imported module: https://cdn.example.com/assets/web-video-engine-B7xK2p1a.js",
        ),
      ),
    ).toBe(true);
  });

  it("reads a failure a loader wrapped in its own error", () => {
    const wrapped = new Error("Module load failed", {
      cause: nodeNotFound(VIDEO_ENGINE_ENTRY),
    });

    expect(isEngineResolutionFailure(wrapped)).toBe(true);
  });

  it("stops walking a cause chain that points at itself", () => {
    const looping = new Error(
      "Cannot find module 'supervision/web-video-engin",
    );
    Object.defineProperty(looping, "cause", { get: () => looping });

    expect(isEngineResolutionFailure(looping)).toBe(false);
  });
});
