import { describe, expect, it } from "vitest";
import type { Filter, GpuProgramOptions } from "pixi.js";
import { createPixiAnnotationAntialiasFilter } from "./pixi-annotation-antialias";

/**
 * A Pixi shader built with a GLSL program alone draws nothing under the WebGPU
 * renderer and raises nothing while doing it: no exception, no failed draw, no
 * type error. The modules are discovered from the directory, so a shader added
 * later is covered without being registered anywhere. A module that holds a
 * stage several shaders draw with writes no shader of its own and is reached
 * through the ones that import it.
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
  readonly uniforms: readonly string[];
  readonly vertex: ShaderStage | undefined;
}

const shaderFiles = readRendererFiles().filter(
  (file) => findProgramCall(readSource(file), 0) >= 0,
);

const programs: readonly ShaderProgram[] = shaderFiles.flatMap((file) =>
  file === "pixi-annotation-antialias.ts"
    ? captureAnnotationPrograms(file)
    : readShaderPrograms(file, readSource(file)),
);

describe("shader programs", () => {
  it("finds every module that writes shader source", () => {
    const glslFiles = readRendererFiles().filter((file) =>
      readSource(file).includes("#version 300 es"),
    );
    const sharedStageFiles = shaderFiles.flatMap((file) =>
      readImportedFiles(readSource(file)),
    );

    expect(shaderFiles).not.toHaveLength(0);
    expect(
      glslFiles.filter(
        (file) =>
          !shaderFiles.includes(file) && !sharedStageFiles.includes(file),
      ),
    ).toEqual([]);
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
      // A resource declared inline names its uniforms where a UniformGroup
      // would have held them, and WebGPU reads those off the struct.
      expect(
        program.uniforms.filter(
          (uniform) => !new RegExp(`\\b${uniform}\\s*:`).test(wgsl),
        ),
      ).toEqual([]);
    });
  }
});

function captureAnnotationPrograms(file: string): readonly ShaderProgram[] {
  // Coverage AA selects its vertex source and resource groups at runtime.
  return [false, true].flatMap((maskCoverage) => {
    const programs: ShaderProgram[] = [];
    createPixiAnnotationAntialiasFilter({
      defaultFilterVert: "void main(void) {}",
      maskCoverage,
      Filter: {
        from(options) {
          const resources = options.resources ?? {};
          programs.push({
            file: `${file} (${maskCoverage ? "coverage" : "annotations"})`,
            fragment: captureStage(options.gpu?.fragment),
            vertex: captureStage(options.gpu?.vertex),
            glStages: Object.keys(options.gl ?? {}),
            resources: [
              "gfu",
              "uTexture",
              "uSampler",
              ...Object.keys(resources),
            ],
            uniforms: Object.values(resources).flatMap((group: object) =>
              Object.keys(group),
            ),
          });
          return {} as Filter;
        },
      },
    });
    if (programs.length === 0)
      throw Error(
        `No AA program was captured for maskCoverage=${maskCoverage}`,
      );
    return programs;
  });
}

function captureStage(
  stage: GpuProgramOptions["vertex"] | undefined,
): ShaderStage | undefined {
  return stage?.entryPoint !== undefined
    ? {
        entryPoint: stage.entryPoint,
        sourceName: "captured",
        wgsl: stage.source,
      }
    : undefined;
}

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
    const callIndex = findProgramCall(source, searchFrom);

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
      resources: [
        ...(source.startsWith("Filter.from(", callIndex)
          ? ["gfu", "uTexture", "uSampler"]
          : []),
        ...readKeys(readNamedBlock(options, "resources")),
      ],
      uniforms: readKeys(readNamedBlock(options, "resources"), 2),
      vertex: readStage(source, gpu, "vertex"),
    });
  }
}

/**
 * A filter is a shader with a stage the renderer supplies, and it declares its
 * two programs through the same option shape, so both build sites are read the
 * same way.
 */
function findProgramCall(source: string, searchFrom: number): number {
  const match = /\b(?:Filter|Shader)\.from\(/.exec(source.slice(searchFrom));

  return match?.index === undefined ? -1 : searchFrom + match.index;
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
  for (const module of [source, ...readImportedSources(source)]) {
    const template = findTemplate(module, name);

    if (template !== undefined) {
      return expandTemplate(module, template);
    }
  }

  throw new Error(`no template literal declares ${name}`);
}

function readImportedFiles(source: string): readonly string[] {
  return [...source.matchAll(/from "(?:\.\/|#renderers\/)([\w-]+)"/g)].map(
    (match) => `${match[1]!}.ts`,
  );
}

function readImportedSources(source: string): readonly string[] {
  return readImportedFiles(source).map((file) => readSource(file));
}

function findTemplate(source: string, name: string): string | undefined {
  const declaration = source.indexOf(`const ${name} = \``);

  if (declaration < 0) {
    return undefined;
  }

  const open = source.indexOf("`", declaration);

  return source.slice(open + 1, source.indexOf("`", open + 1));
}

function expandTemplate(source: string, template: string): string {
  // A shader also interpolates plain numbers, which name no template and so
  // stay as written.
  return template.replace(/\$\{(\w+)\}/g, (reference, name: string) => {
    const part = findTemplate(source, name);

    return part === undefined ? reference : expandTemplate(source, part);
  });
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
