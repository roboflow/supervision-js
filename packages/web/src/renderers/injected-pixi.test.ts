import { describe, expect, it } from "vitest";

/**
 * A shader built from a GLSL program alone draws nothing under the WebGPU
 * renderer and raises nothing while doing it, and a factory that asks for only
 * the GLSL program still satisfies a parameter that asks for both, so the
 * requirement has to be read off the declaration itself. The declarations are
 * discovered from the directory, so a renderer that writes its own is covered
 * without being registered anywhere.
 */
const fsModuleName = "node:fs";
const { readFileSync, readdirSync } = (await import(fsModuleName)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL): string[];
};

interface ShaderFactoryDeclaration {
  readonly file: string;
  readonly gpuStages: readonly string[];
  readonly options: readonly string[];
  readonly stageFields: readonly string[];
}

const declarations: readonly ShaderFactoryDeclaration[] =
  readRendererFiles().flatMap((file) =>
    readShaderFactoryDeclarations(file, readSource(file)),
  );

describe("injected shader factory", () => {
  it("reaches every renderer that injects one", () => {
    const injectingFiles = readRendererFiles().filter((file) =>
      /\bShader\??:/.test(readSource(file)),
    );
    const declaringFiles = new Set(declarations.map(({ file }) => file));

    expect(declarations).not.toHaveLength(0);
    expect(
      injectingFiles.filter(
        (file) =>
          !declaringFiles.has(file) &&
          !readSource(file).includes("InjectedShaderFactory"),
      ),
    ).toEqual([]);
  });

  for (const declaration of declarations) {
    it(`${declaration.file} requires a program for both renderer backends`, () => {
      expect(declaration.options).toContain("gl");
      expect(declaration.options).toContain("gpu");
      expect([...declaration.gpuStages].sort()).toEqual(["fragment", "vertex"]);
      expect([...new Set(declaration.stageFields)].sort()).toEqual([
        "entryPoint",
        "source",
      ]);
    });
  }
});

function readRendererFiles(): readonly string[] {
  return readdirSync(new URL(".", import.meta.url)).filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"),
  );
}

function readSource(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

function readShaderFactoryDeclarations(
  file: string,
  source: string,
): readonly ShaderFactoryDeclaration[] {
  const declarations: ShaderFactoryDeclaration[] = [];
  let searchFrom = 0;

  for (;;) {
    const callIndex = source.indexOf("from(options:", searchFrom);

    if (callIndex < 0) {
      return declarations;
    }

    const options = readBlock(source, source.indexOf("{", callIndex));
    const gpu = readNamedBlock(options, "gpu");

    searchFrom = callIndex + options.length;
    declarations.push({
      file,
      gpuStages: readKeys(gpu),
      options: readKeys(options),
      stageFields: readKeys(gpu, 2),
    });
  }
}

function readNamedBlock(source: string, name: string): string | undefined {
  const key = source.match(new RegExp(`(^|[\\s{,])${name}:\\s*{`));

  if (!key || key.index === undefined) {
    return undefined;
  }

  return readBlock(source, source.indexOf("{", key.index + key[0].length - 1));
}

function readKeys(block: string | undefined, depth = 1): readonly string[] {
  const keys: string[] = [];
  let level = 0;

  for (const match of (block ?? "").matchAll(/[{}]|(\w+)\s*:/g)) {
    if (match[0] === "{") {
      level += 1;
    } else if (match[0] === "}") {
      level -= 1;
    } else if (level === depth) {
      keys.push(match[1]!);
    }
  }

  return keys;
}

function readBlock(source: string, openIndex: number): string {
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(openIndex, index + 1);
      }
    }
  }

  throw new Error(`unbalanced block at ${openIndex}`);
}
