import {
  BindGroup,
  Buffer,
  BufferResource,
  BufferUsage,
  Filter,
  GlProgram,
  MaskFilter,
  Matrix,
  Sprite,
  Texture,
  TextureSource,
  UniformGroup,
} from "pixi.js";
import type {
  AlphaMaskPipe,
  BindOptions,
  FilterSystem,
  Renderer,
} from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPixiFilterBindings } from "./pixi-filter-bindings";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function createPipeline(name = "webgpu") {
  const source = new TextureSource({ width: 2, height: 2 });
  const texture = new Texture({ source });
  const buffer = new Buffer({
    data: new Float32Array(32),
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const uniform = new BufferResource({ buffer, offset: 0, size: 128 });
  const group = new BindGroup({});
  const system = {
    applyFilter: vi.fn<FilterSystem["applyFilter"]>(function (
      this: unknown,
      filter,
      input,
    ) {
      expect(this).toBe(system);
      if (!filter.enabled) return;
      group.setResource(uniform, 0);
      group.setResource(input.source, 1);
      group.setResource(input.source.style, 2);
      filter.groups[0] = group;
    }),
  };
  const renderer = { name, filter: system } as unknown as Renderer;
  cleanups.push(() => {
    group.destroy();
    uniform.destroy();
    buffer.destroy();
    texture.destroy(true);
  });
  const cleanup = installPixiFilterBindings(
    { MaskFilter, UniformGroup },
    renderer,
  );
  cleanups.push(cleanup);
  return {
    apply(filter: Filter) {
      system.applyFilter(filter, texture, texture, true);
    },
    buffer,
    cleanup,
    group,
    source,
    system,
    uniform,
  };
}

function createFilter() {
  const filter = Filter.from({
    gpu: {
      vertex: {
        entryPoint: "mainVertex",
        source: `@vertex fn mainVertex() -> @builtin(position) vec4<f32> {
          return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }`,
      },
      fragment: {
        entryPoint: "mainFragment",
        source: `@fragment fn mainFragment() -> @location(0) vec4<f32> {
          return vec4<f32>(1.0);
        }`,
      },
    },
  });
  cleanups.push(() => filter.destroy());
  return filter;
}

function createMaskFilter() {
  const sprite = new Sprite(Texture.WHITE);
  const compileGl = vi
    .spyOn(GlProgram, "from")
    .mockReturnValue(undefined as unknown as GlProgram);
  const filter = new MaskFilter({ sprite });
  compileGl.mockRestore();
  cleanups.push(() => {
    filter.destroy();
    sprite.destroy();
  });
  return filter;
}

function allocateUniformBuffer(group: UniformGroup) {
  const buffer = new Buffer({
    data: new Float32Array(32),
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  group.buffer = buffer;
  cleanups.push(() => {
    if (!buffer.destroyed) buffer.destroy();
  });
  return buffer;
}

function createTargetPipeline(name: "webgpu" | "webgl", failAtEnd = false) {
  const makeTexture = () => {
    const texture = new Texture({
      source: new TextureSource({ width: 4, height: 4 }),
    });
    cleanups.push(() => texture.destroy(true));
    return texture;
  };
  const root = makeTexture();
  const capture = makeTexture();
  const mask = makeTexture();
  const rootBinding: BindOptions = { target: root, clear: false };
  let binding = rootBinding;
  const stack = [rootBinding];
  const observed: BindOptions[] = [];
  const targets = {
    getBindState: () => ({ ...binding, clear: false }),
    bind: vi.fn((next: BindOptions) => {
      binding = next;
      return next.target;
    }),
    push(next: BindOptions) {
      stack.push(next);
      return targets.bind(next);
    },
    pop: vi.fn(() => {
      stack.pop();
      return targets.bind(stack.at(-1)!);
    }),
  };
  const pipe = {
    execute: vi.fn(function (
      this: unknown,
      instruction: Parameters<AlphaMaskPipe["execute"]>[0],
    ) {
      expect(this).toBe(pipe);
      if (!instruction.mask.renderMaskToTexture) return;
      if (instruction.action === "pushMaskBegin") {
        targets.push({ target: mask, clear: true });
      } else if (instruction.action === "pushMaskEnd") {
        targets.pop();
        observed.push(targets.getBindState());
        if (failAtEnd) throw new Error("mask capture failed");
      }
    }),
  };
  const renderer = {
    name,
    filter: { applyFilter: vi.fn() },
    renderPipes: { alphaMask: pipe },
    renderTarget: targets,
  } as unknown as Renderer;
  const originalPop = targets.pop;
  const originalExecute = pipe.execute;
  const cleanup = installPixiFilterBindings(
    { MaskFilter, UniformGroup },
    renderer,
  );
  cleanups.push(cleanup);
  return {
    begin() {
      pipe.execute({
        action: "pushMaskBegin",
        mask: { renderMaskToTexture: true },
      } as Parameters<AlphaMaskPipe["execute"]>[0]);
    },
    end() {
      pipe.execute({
        action: "pushMaskEnd",
        mask: { renderMaskToTexture: true },
      } as Parameters<AlphaMaskPipe["execute"]>[0]);
    },
    capture,
    cleanup,
    mask,
    observed,
    originalExecute,
    originalPop,
    pipe,
    targets,
  };
}

describe("renderer-scoped Pixi filter bindings", () => {
  it.each(["webgpu", "webgl"] as const)(
    "keeps nested alpha masks inside the bound %s annotation capture",
    (name) => {
      const scene = createTargetPipeline(name);
      const firstBinding = {
        target: scene.capture,
        clear: false,
        mipLevel: 1,
        layer: 2,
        flipY: true,
      };
      scene.targets.bind(firstBinding);
      scene.begin();
      scene.targets.bind({ target: scene.mask, clear: false });
      scene.begin();
      scene.end();
      scene.end();

      expect(scene.observed).toEqual([
        { target: scene.mask, clear: false },
        firstBinding,
      ]);
      expect(scene.targets.pop).toBe(scene.originalPop);
      scene.cleanup();
      expect(scene.pipe.execute).toBe(scene.originalExecute);
    },
  );

  it("restores target methods after a failed capture and keeps scenes independent", () => {
    const first = createTargetPipeline("webgl", true);
    const second = createTargetPipeline("webgl");
    first.targets.bind({ target: first.capture, clear: false });
    second.targets.bind({ target: second.capture, clear: false });
    first.begin();
    second.begin();
    expect(() => first.end()).toThrow("mask capture failed");
    expect(first.targets.pop).toBe(first.originalPop);
    first.cleanup();
    second.end();

    expect(second.observed).toEqual([{ target: second.capture, clear: false }]);
    second.cleanup();
    expect(second.pipe.execute).toBe(second.originalExecute);
  });

  it("gives pooled mask uniforms one buffer per renderer and keeps staged values", () => {
    const first = createPipeline();
    const second = createPipeline();
    const filter = createMaskFilter();
    const original = filter.resources.filterUniforms as UniformGroup;
    const program = filter.gpuProgram;
    filter.inverse = true;
    filter.channel = "alpha";
    first.apply(filter);
    const firstGroup = filter.resources.filterUniforms as UniformGroup;
    const firstBuffer = allocateUniformBuffer(firstGroup);
    expect(firstGroup).not.toBe(original);
    expect(firstGroup.uniforms.uInverse).toBe(1);
    expect(firstGroup.uniforms.uChannel).toBe(1);

    filter.inverse = false;
    filter.channel = "red";
    const matrix = new Matrix(1, 0, 0, 1, 18, 4);
    const clamp = new Float32Array([0, 0, 0.5, 0.75]);
    filter.resources.filterUniforms.uniforms.uFilterMatrix = matrix;
    filter.resources.filterUniforms.uniforms.uMaskClamp = clamp;
    second.apply(filter);
    const secondGroup = filter.resources.filterUniforms as UniformGroup;
    const secondBuffer = allocateUniformBuffer(secondGroup);
    expect(secondGroup).not.toBe(original);
    expect(secondGroup).not.toBe(firstGroup);
    expect(secondBuffer).not.toBe(firstBuffer);
    expect(secondGroup.uniforms).toMatchObject({
      uInverse: 0,
      uChannel: 0,
      uFilterMatrix: matrix,
      uMaskClamp: clamp,
    });

    filter.inverse = true;
    filter.channel = "alpha";
    clamp.set([0, 0, 1, 1]);
    first.apply(filter);
    expect(filter.resources.filterUniforms).toBe(firstGroup);
    expect(firstGroup.buffer).toBe(firstBuffer);
    expect(firstGroup.uniforms).toMatchObject({
      uInverse: 1,
      uChannel: 1,
      uFilterMatrix: matrix,
      uMaskClamp: clamp,
    });
    expect(Array.from(firstGroup.uniforms.uMaskClamp as Float32Array)).toEqual([
      0, 0, 1, 1,
    ]);
    expect(filter.gpuProgram).toBe(program);
  });

  it("releases only a retired scene's mask buffers and restores the pool resource", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = createPipeline();
    const second = createPipeline();
    const filter = createMaskFilter();
    const original = filter.resources.filterUniforms as UniformGroup;
    first.apply(filter);
    const firstGroup = filter.resources.filterUniforms as UniformGroup;
    const firstBuffer = allocateUniformBuffer(firstGroup);
    second.apply(filter);
    const secondGroup = filter.resources.filterUniforms as UniformGroup;
    const secondBuffer = allocateUniformBuffer(secondGroup);

    filter.enabled = false;
    first.apply(filter);
    first.cleanup();
    first.cleanup();
    expect(filter.resources.filterUniforms).toBe(secondGroup);
    expect(firstBuffer.destroyed).toBe(true);
    expect(firstGroup.buffer).toBeUndefined();
    expect(secondBuffer.destroyed).toBe(false);

    filter.enabled = true;
    filter.inverse = true;
    second.apply(filter);
    expect(filter.resources.filterUniforms).toBe(secondGroup);
    second.cleanup();
    expect(filter.resources.filterUniforms).toBe(original);
    expect(original.uniforms.uInverse).toBe(1);
    expect(secondBuffer.destroyed).toBe(true);
    expect(secondGroup.buffer).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("can dispose a mask filter before its scene retires", () => {
    const pipe = createPipeline();
    const filter = createMaskFilter();
    pipe.apply(filter);
    const owned = filter.resources.filterUniforms as UniformGroup;
    const buffer = allocateUniformBuffer(owned);
    filter.destroy();

    expect(() => pipe.cleanup()).not.toThrow();
    expect(buffer.destroyed).toBe(true);
    expect(owned.buffer).toBeUndefined();
  });

  it("releases shared filter bindings before destroying renderer resources", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pipe = createPipeline();
    const filter = createFilter();
    const program = filter.gpuProgram;
    const destroyGroup = vi.spyOn(pipe.group, "destroy");

    pipe.apply(filter);
    expect(pipe.group.getResource(0)).toBe(pipe.uniform);
    pipe.cleanup();
    pipe.cleanup();

    expect(destroyGroup).toHaveBeenCalledTimes(1);
    expect(pipe.group.resources).toBeNull();
    expect(pipe.uniform.destroyed).toBe(false);
    expect(pipe.source.destroyed).toBe(false);
    expect(pipe.source.style.destroyed).toBe(false);
    expect(filter.gpuProgram).toBe(program);

    pipe.uniform.destroy();
    pipe.source.destroy();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps bindings live across toggles and retired filters", () => {
    const pipe = createPipeline();
    const retired = createFilter();
    const program = retired.gpuProgram;
    pipe.apply(retired);
    retired.enabled = false;
    pipe.apply(retired);
    retired.destroy();

    expect(pipe.group.getResource(0)).toBe(pipe.uniform);
    const replacement = createFilter();
    expect(replacement.gpuProgram).toBe(program);
    pipe.apply(replacement);
    expect(replacement.groups[0]).toBe(pipe.group);
    expect(pipe.group.getResource(1)).toBe(pipe.source);

    pipe.cleanup();
    expect(pipe.group.resources).toBeNull();
  });

  it("preserves another renderer when a disabled filter retains its group", () => {
    const first = createPipeline();
    const second = createPipeline();
    const shared = createFilter();
    const program = shared.gpuProgram;

    first.apply(shared);
    second.apply(shared);
    shared.enabled = false;
    first.apply(shared);
    first.cleanup();

    expect(first.group.resources).toBeNull();
    expect(second.group.getResource(0)).toBe(second.uniform);
    expect(second.group.getResource(1)).toBe(second.source);
    expect(shared.gpuProgram).toBe(program);
    shared.enabled = true;
    second.apply(shared);
    expect(shared.groups[0]).toBe(second.group);
    second.cleanup();
    expect(second.group.resources).toBeNull();
  });

  it("restores the public apply method even if no filter was rendered", () => {
    const pipe = createPipeline();
    const wrapped = pipe.system.applyFilter;
    pipe.cleanup();

    expect(pipe.system.applyFilter).not.toBe(wrapped);
    expect(vi.isMockFunction(pipe.system.applyFilter)).toBe(true);
    expect(pipe.group.resources).not.toBeNull();
  });

  it("leaves WebGL filter bindings unchanged", () => {
    const pipe = createPipeline("webgl");
    const apply = pipe.system.applyFilter;
    pipe.apply(createFilter());
    pipe.cleanup();

    expect(pipe.system.applyFilter).toBe(apply);
    expect(pipe.group.getResource(0)).toBe(pipe.uniform);
  });
});
