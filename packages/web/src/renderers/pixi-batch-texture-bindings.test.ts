import * as pixi from "pixi.js";
import type { Batch, BatcherPipe, Geometry, Renderer, Shader } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPixiBatchTextureBindings } from "./pixi-batch-texture-bindings";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function createPipeline(name = "webgpu") {
  const groups: pixi.BindGroup[] = [];
  const adaptor = new pixi.GpuBatchAdaptor();
  const execute = vi.fn((batch: Batch) => adaptor.execute(pipe, batch));
  const renderer = {
    name,
    tick: 1,
    gc: { now: 1 },
    limits: { maxBatchableTextures: 4 },
    globalUniforms: { bindGroup: {} },
    encoder: {
      setGeometry: vi.fn(),
      resetBindGroup: vi.fn(),
      setBindGroup: vi.fn(),
      setPipeline: vi.fn(),
      renderPassEncoder: { setBindGroup: vi.fn(), drawIndexed: vi.fn() },
    },
    pipeline: { getPipeline: vi.fn(() => ({})) },
    bindGroup: {
      getBindGroup: vi.fn((group: pixi.BindGroup) => {
        expect(group.resources).not.toBeNull();
        for (const resource of Object.values(group.resources)) {
          expect(resource.destroyed).toBe(false);
        }
        groups.push(group);
        return {};
      }),
    },
    renderPipes: {},
  } as unknown as Renderer;
  const pipe = { renderer, execute } as unknown as BatcherPipe;
  renderer.renderPipes.batch = pipe;
  adaptor.start(pipe, {} as Geometry, { gpuProgram: {} } as Shader);
  const cleanup = installPixiBatchTextureBindings(pixi, renderer);
  cleanups.push(cleanup);
  return { cleanup, execute, groups, pipe, renderer };
}

function createSource() {
  const source = new pixi.TextureSource({ width: 2, height: 2 });
  cleanups.push(() => {
    if (!source.destroyed) source.destroy();
  });
  return source;
}

function createBatch(...sources: pixi.TextureSource[]): Batch {
  return {
    action: "renderBatch",
    bindGroup: null,
    blendMode: "normal",
    size: 6,
    start: 0,
    textures: { count: sources.length, textures: sources },
    topology: "triangle-list",
  } as unknown as Batch;
}

describe("renderer-owned Pixi batch texture bindings", () => {
  it("reuses live groups and updates their GPU key after an unload", () => {
    const { pipe } = createPipeline();
    const source = createSource();
    const first = createBatch(source);
    pipe.execute(first);
    const key = first.bindGroup._key;
    source.unload();
    const next = createBatch(source);
    pipe.execute(next);

    expect(next.bindGroup).toBe(first.bindGroup);
    expect(next.bindGroup._key).not.toBe(key);
  });

  it("retires every affected group before GPU disposal without detaching other owners", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { pipe } = createPipeline();
    const retired = createSource();
    const live = createSource();
    const independent = createSource();
    const externalChange = vi.fn();
    live.on("change", externalChange);
    const liveListeners = live.listenerCount("change");
    const emptyListeners = pixi.Texture.EMPTY.source.listenerCount("change");
    const first = createBatch(retired, live);
    const second = createBatch(live, retired);
    const unaffected = createBatch(independent);
    pipe.execute(first);
    pipe.execute(second);
    pipe.execute(unaffected);
    const beforeGpuDisposal = vi.fn(() => {
      expect(first.bindGroup.resources).toBeNull();
      expect(second.bindGroup.resources).toBeNull();
      expect(live.listenerCount("change")).toBe(liveListeners);
    });
    retired.on("unload", beforeGpuDisposal);

    retired.destroy();
    live.unload();

    expect(beforeGpuDisposal).toHaveBeenCalledOnce();
    expect(externalChange).toHaveBeenCalledOnce();
    expect(unaffected.bindGroup.getResource(0)).toBe(independent);
    expect(pixi.Texture.EMPTY.source.listenerCount("change")).toBe(
      emptyListeners + 3,
    );
    expect(warning).not.toHaveBeenCalled();
  });

  it("recreates a retired batch group before reusing the batch", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { pipe, execute } = createPipeline();
    const source = createSource();
    const batch = createBatch(source);
    pipe.execute(batch);
    const retiredGroup = batch.bindGroup;
    source.destroy();
    pipe.execute(batch);

    expect(batch.bindGroup).not.toBe(retiredGroup);
    expect(batch.bindGroup.getResource(0)).toBe(pixi.Texture.EMPTY.source);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
  });

  it("handles repeated sources in one batch without duplicate teardown", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { pipe } = createPipeline();
    const source = createSource();
    const batch = createBatch(source, source);
    pipe.execute(batch);

    expect(() => source.destroy()).not.toThrow();
    expect(batch.bindGroup.resources).toBeNull();
    expect(warning).not.toHaveBeenCalled();
  });

  it("preserves shared styles and replaces bindings when a source changes style", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { pipe } = createPipeline();
    const shared = new pixi.TextureStyle();
    cleanups.push(() => shared.destroy());
    const first = createSource();
    const second = createSource();
    first.style = shared;
    second.style = shared;
    const firstBatch = createBatch(first);
    const secondBatch = createBatch(second);
    pipe.execute(firstBatch);
    pipe.execute(secondBatch);
    first.destroy();

    expect(shared.destroyed).toBe(false);
    expect(secondBatch.bindGroup.getResource(1)).toBe(shared);

    const replacement = new pixi.TextureStyle({ scaleMode: "nearest" });
    cleanups.push(() => replacement.destroy());
    const retiredGroup = secondBatch.bindGroup;
    second.style = replacement;
    pipe.execute(secondBatch);
    expect(secondBatch.bindGroup).not.toBe(retiredGroup);
    expect(secondBatch.bindGroup.getResource(1)).toBe(replacement);
    expect(warning).not.toHaveBeenCalled();
  });

  it("retires groups when a shared sampler is destroyed", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { pipe } = createPipeline();
    const shared = new pixi.TextureStyle();
    const first = createSource();
    const second = createSource();
    first.style = shared;
    second.style = shared;
    const batch = createBatch(first, second);
    pipe.execute(batch);

    shared.destroy();
    expect(batch.bindGroup.resources).toBeNull();
    pipe.execute(batch);
    expect(batch.bindGroup.getResource(0)).toBe(pixi.Texture.EMPTY.source);
    expect(warning).not.toHaveBeenCalled();
  });

  it("releases all owned listeners at teardown and leaves another renderer usable", () => {
    const first = createPipeline();
    const second = createPipeline();
    const source = createSource();
    const listeners = source.listenerCount("change");
    const firstBatch = createBatch(source);
    const secondBatch = createBatch(source);
    first.pipe.execute(firstBatch);
    second.pipe.execute(secondBatch);
    expect(firstBatch.bindGroup).not.toBe(secondBatch.bindGroup);
    first.cleanup();
    first.cleanup();

    expect(first.pipe.execute).toBe(first.execute);
    expect(firstBatch.bindGroup.resources).toBeNull();
    expect(source.listenerCount("change")).toBe(listeners + 1);
    second.pipe.execute(secondBatch);
    expect(secondBatch.bindGroup.getResource(0)).toBe(source);
  });

  it("leaves the WebGL batch pipe unchanged", () => {
    const { pipe, execute } = createPipeline("webgl");
    expect(pipe.execute).toBe(execute);
  });

  it("keeps Pixi warnings for unowned shader bindings", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    createPipeline();
    const source = createSource();
    const unowned = new pixi.BindGroup({ texture: source });
    source.destroy();

    expect(warning).toHaveBeenCalledWith(
      "PixiJS Warning: ",
      expect.stringContaining("was destroyed while still bound"),
    );
    unowned.destroy();
  });
});
