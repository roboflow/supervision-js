import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const FRAME_INDEX_TOKEN = /\{index(?::0(\d{1,2}))?\}/g;

interface FixtureDepthMeta {
  readonly depth?: {
    readonly layers?: readonly { readonly manifest?: unknown }[];
  };
}

interface DepthManifestFiles {
  readonly frames?: {
    readonly count?: unknown;
    readonly exact?: unknown;
    readonly confidence?: unknown;
  };
  readonly image?: {
    readonly file?: unknown;
    readonly confidence_file?: unknown;
  };
  readonly preview?: { readonly file?: unknown };
}

/**
 * Copies every fixture depth layer into the build under its own name.
 *
 * A depth.json names its frames by pattern, relative to itself, so the files
 * cannot become hashed assets the way fixture media and detection chunks do.
 * The dev server already serves them from `fixtures/` as they are; this puts
 * the same tree at the same place in `dist/`.
 */
export function fixtureDepthFilesPlugin(fixturesDirectory: string): Plugin {
  return {
    apply: "build",
    name: "supervision-js-demo-fixture-depth-files",
    async generateBundle() {
      for (const file of await listFixtureDepthFiles(fixturesDirectory)) {
        this.emitFile({
          fileName: path.posix.join(
            "fixtures",
            path.relative(fixturesDirectory, file).split(path.sep).join("/"),
          ),
          source: await readFile(file),
          type: "asset",
        });
      }
    },
  };
}

/** Every file each fixture's depth manifests name, the manifests included. */
export async function listFixtureDepthFiles(
  fixturesDirectory: string,
): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(fixturesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;

    const fixture = path.join(fixturesDirectory, entry.name);
    const meta = await readJson<FixtureDepthMeta>(
      path.join(fixture, "fixture.meta.json"),
    );

    for (const layer of meta?.depth?.layers ?? []) {
      if (typeof layer.manifest !== "string") continue;

      const manifestPath = path.join(fixture, layer.manifest);
      const manifest = await readJson<DepthManifestFiles>(manifestPath);

      if (!manifest) {
        throw new Error(`Fixture depth manifest ${manifestPath} is missing.`);
      }

      const folder = path.dirname(manifestPath);

      files.push(
        manifestPath,
        ...namedFiles(manifest).map((name) => path.join(folder, name)),
      );
    }
  }

  return files;
}

function namedFiles(manifest: DepthManifestFiles): string[] {
  const names: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string") names.push(name);
  };
  const { frames, image, preview } = manifest;

  add(image?.file);
  add(image?.confidence_file);
  add(preview?.file);
  if (frames && typeof frames.count === "number") {
    for (let index = 0; index < frames.count; index += 1) {
      for (const pattern of [frames.exact, frames.confidence]) {
        if (typeof pattern === "string") add(expandFrame(pattern, index));
      }
    }
  }

  return names;
}

function expandFrame(pattern: string, index: number) {
  return pattern.replace(FRAME_INDEX_TOKEN, (_token, width?: string) =>
    width === undefined
      ? String(index)
      : String(index).padStart(Number(width), "0"),
  );
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}
