import { describe, expect, it } from "vitest";

/**
 * A Pixi shader built with a GLSL program alone draws nothing under the WebGPU
 * renderer and raises nothing while doing it: no exception, no failed draw, no
 * type error. The modules are discovered from the directory, so a shader added
 * later is covered without being registered anywhere.
 */
const fsModuleName = "node:fs";
const { readFileSync, readdirSync } = (await import(fsModuleName)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL): string[];
};

interface ShaderStage {
  readonly entryPoint: string;
  readonly sourceName: string;
  readonly wgsl: string;
}

interface ShaderProgram {
  readonly file: string;
  readonly fragment: ShaderStage | undefined;
  readonly glStages: readonly string[];
  readonly resources: readonly string[];
  readonly vertex: ShaderStage | undefined;
}

const shaderFiles = readRendererFiles().filter((file) =>
  readSource(file).includes("Shader.from("),
);

const programs: readonly ShaderProgram[] = shaderFiles.flatMap((file) =>
  readShaderPrograms(file, readSource(file)),
);

describe("shader programs", () => {
  it("finds every module that writes shader source", () => {
    const glslFiles = readRendererFiles().filter((file) =>
      readSource(file).includes("#version 300 es"),
    );

    expect(shaderFiles).not.toHaveLength(0);
    expect(glslFiles.filter((file) => !shaderFiles.includes(file))).toEqual([]);
    expect(programs.length).toBeGreaterThanOrEqual(shaderFiles.length);
  });

  for (const program of programs) {
    it(`${program.file} carries a program for both renderer backends`, () => {
      expect([...program.glStages].sort()).toEqual(["fragment", "vertex"]);
      expect(program.vertex?.entryPoint).toBeDefined();
      expect(program.fragment?.entryPoint).toBeDefined();
      expect(program.vertex?.wgsl).toContain(
        `fn ${program.vertex?.entryPoint}`,
      );
      expect(program.fragment?.wgsl).toContain(
        `fn ${program.fragment?.entryPoint}`,
      );
    });

    it(`${program.file} declares every named resource in WGSL`, () => {
      const wgsl = [program.vertex?.wgsl, program.fragment?.wgsl].join("\n");

      expect(program.resources).not.toHaveLength(0);
      // WebGPU binds a resource by the name it is declared under, so a rename
      // that reaches only one program leaves the draw sampling nothing.
      expect(
        program.resources.filter(
          (resource) =>
            !new RegExp(`\\bvar(?:<[^>]*>)?\\s+${resource}\\s*:`).test(wgsl),
        ),
      ).toEqual([]);
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

function readShaderPrograms(
  file: string,
  source: string,
): readonly ShaderProgram[] {
  const programs: ShaderProgram[] = [];
  let searchFrom = 0;

  for (;;) {
    const callIndex = source.indexOf("Shader.from(", searchFrom);

    if (callIndex < 0) {
      return programs;
    }

    const options = readBlock(source, source.indexOf("{", callIndex));
    const gpu = readNamedBlock(options, "gpu");

    searchFrom = callIndex + options.length;
    programs.push({
      file,
      fragment: readStage(source, gpu, "fragment"),
      glStages: readKeys(readNamedBlock(options, "gl")),
      resources: readKeys(readNamedBlock(options, "resources")),
      vertex: readStage(source, gpu, "vertex"),
    });
  }
}

function readStage(
  source: string,
  gpu: string | undefined,
  stage: string,
): ShaderStage | undefined {
  const block = gpu === undefined ? undefined : readNamedBlock(gpu, stage);
  const entryPoint = block?.match(/entryPoint:\s*"([^"]+)"/)?.[1];
  const sourceName = block?.match(/source:\s*(\w+)/)?.[1];

  if (entryPoint === undefined || sourceName === undefined) {
    return undefined;
  }

  return { entryPoint, sourceName, wgsl: readTemplate(source, sourceName) };
}

function readTemplate(source: string, name: string): string {
  const declaration = source.indexOf(`const ${name} = \``);

  if (declaration < 0) {
    throw new Error(`no template literal declares ${name}`);
  }

  const open = source.indexOf("`", declaration);

  return source.slice(open + 1, source.indexOf("`", open + 1));
}

function readNamedBlock(source: string, name: string): string | undefined {
  const key = source.match(new RegExp(`(^|[\\s{,])${name}:\\s*{`));

  if (!key || key.index === undefined) {
    return undefined;
  }

  return readBlock(source, source.indexOf("{", key.index + key[0].length - 1));
}

function readKeys(block: string | undefined): readonly string[] {
  return [...(block ?? "").matchAll(/(?:^|[{,])\s*(\w+):/g)].map(
    (match) => match[1]!,
  );
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
