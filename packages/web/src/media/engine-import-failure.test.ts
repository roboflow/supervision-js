import { describe, expect, it } from "vitest";

import {
  isEngineResolutionFailure,
  rethrowEngineImportFailure,
  VIDEO_ENGINE_ANALYSIS_ENTRY,
  VIDEO_ENGINE_PACKAGE,
} from "./engine-import-failure";

function nodeNotFound(specifier: string): Error {
  const error = new Error(
    `Cannot find package '${specifier}' imported from /app/node_modules/supervision/dist/index.js`,
  );
  Object.assign(error, { code: "ERR_MODULE_NOT_FOUND" });
  return error;
}

describe("engine import failure", () => {
  it("names the install command when the engine is not installed", () => {
    expect(() =>
      rethrowEngineImportFailure(
        nodeNotFound(VIDEO_ENGINE_PACKAGE),
        VIDEO_ENGINE_PACKAGE,
      ),
    ).toThrow(
      /openVideoEngineMediaSource needs "supervision-js-web-video-engine".*npm install supervision-js-web-video-engine/s,
    );
  });

  it("names the entry the caller reached for", () => {
    expect(() =>
      rethrowEngineImportFailure(
        nodeNotFound(VIDEO_ENGINE_ANALYSIS_ENTRY),
        VIDEO_ENGINE_ANALYSIS_ENTRY,
      ),
    ).toThrow(/needs "supervision-js-web-video-engine\/analysis"/);
  });

  it("keeps the original failure as the cause", () => {
    const original = nodeNotFound(VIDEO_ENGINE_PACKAGE);

    try {
      rethrowEngineImportFailure(original, VIDEO_ENGINE_PACKAGE);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).cause).toBe(original);
    }
  });

  it("passes through an engine that loaded and then threw", () => {
    const thrown = new Error("WebCodecs is unavailable in this browser.");

    expect(() =>
      rethrowEngineImportFailure(thrown, VIDEO_ENGINE_PACKAGE),
    ).toThrow(thrown);
  });

  it("blames the package the loader actually failed to find", () => {
    // The engine is installed; something it depends on is not. The engine's
    // name is in the importer path, so only the quoted specifier settles it.
    expect(isEngineResolutionFailure(nodeNotFound("mediabunny"))).toBe(false);
  });

  it("reads a browser failure, which quotes no specifier", () => {
    expect(
      isEngineResolutionFailure(
        new Error(
          "Failed to fetch dynamically imported module: https://cdn.example.com/supervision-js-web-video-engine/dist/index.js",
        ),
      ),
    ).toBe(true);
  });

  it("reads a failure a loader wrapped in its own error", () => {
    const wrapped = new Error("Module load failed", {
      cause: nodeNotFound(VIDEO_ENGINE_PACKAGE),
    });

    expect(isEngineResolutionFailure(wrapped)).toBe(true);
  });

  it("stops walking a cause chain that points at itself", () => {
    const looping = new Error("Cannot find module 'supervision-js-video-engin");
    Object.defineProperty(looping, "cause", { get: () => looping });

    expect(isEngineResolutionFailure(looping)).toBe(false);
  });
});
