import {
  BindGroup,
  GpuBufferSystem,
  GpuUboSystem,
  ImageSource,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
  type GPU,
  type WebGPURenderer,
} from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import { createPixiIdMaskShaderRenderer } from "#renderers/pixi-id-mask-shader";
import { PACKED_MASK_UNIT_BACKING_BYTES } from "#renderers/pixi-ordered-mask-units";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("pixi ID-mask shader resources", () => {
  it("reserves the known paint, UBO, geometry and placeholder backing", () => {
    const { descriptorValues, uniforms, geometryBuffers, gpuBuffers, source } =
      createResourceOwner();
    const paintBytes = uniqueArrayBytes([
      ...descriptorValues,
      ...Object.values(uniforms.uniforms),
    ]);
    const uniformBytes = uniforms.buffer!.data.byteLength;
    const geometryBytes = geometryBuffers.reduce(
      (total, buffer) => total + buffer.data.byteLength,
      0,
    );
    const gpuBytes = gpuBuffers.reduce(
      (total, buffer) => total + buffer.size,
      0,
    );
    expect(source.format).toMatch(/^(rgba|bgra)8unorm$/);
    // One four-channel pixel on each side of the upload. Shared renderer
    // caches and object/driver overhead are outside this unit's backing.
    const placeholderBytes = source.width * source.height * 4 * 2;

    expect(
      paintBytes + uniformBytes + geometryBytes + gpuBytes + placeholderBytes,
    ).toBeLessThanOrEqual(PACKED_MASK_UNIT_BACKING_BYTES);
  });

  it("retains its uniform group and allocated buffer across a shader rebuild", () => {
    const { owner, uniforms, gpuBuffers } = createResourceOwner();
    const shader = owner.mesh.shader!;
    const program = shader.gpuProgram;
    const buffer = uniforms.buffer;

    shader.destroy();
    owner.clearTexture();

    expect(owner.mesh.shader).not.toBe(shader);
    expect(owner.mesh.shader!.resources.maskUniforms).toBe(uniforms);
    expect(uniforms.buffer).toBe(buffer);
    expect(buffer!.destroyed).toBe(false);
    expect(owner.mesh.shader!.gpuProgram).toBe(program);
    expect(program!.layout).not.toBeNull();
    for (const gpuBuffer of gpuBuffers) {
      expect(gpuBuffer.destroy).not.toHaveBeenCalled();
    }
  });

  it("releases its buffers immediately while keeping renderer-owned groups alive", () => {
    const { owner, uniforms, geometryBuffers, gpuBuffers, gpuSystem, destroy } =
      createResourceOwner();
    const ownedBuffers = [uniforms.buffer!, ...geometryBuffers];
    const sharedUniforms = new UniformGroup({
      uColor: { type: "vec4<f32>", value: new Float32Array(4) },
    });
    const ubo = new GpuUboSystem();
    ubo.updateUniformGroup(sharedUniforms);
    const sharedBuffer = sharedUniforms.buffer!;
    const sharedGpuBuffer = gpuSystem.getGPUBuffer(sharedBuffer);
    const sharedGroup = new BindGroup({ uniforms: sharedUniforms });
    owner.mesh.shader!.groups[0] = sharedGroup;
    owner.mesh.shader!.groups[1] = sharedGroup;
    cleanups.push(() => {
      sharedGroup.destroy();
      sharedUniforms.buffer = undefined;
      sharedBuffer.destroy();
      ubo.destroy();
    });

    destroy();

    expect(uniforms.buffer).toBeUndefined();
    for (const buffer of ownedBuffers) {
      expect(buffer.destroyed).toBe(true);
      expect(Object.keys(buffer._gpuData)).toEqual([]);
      expect(gpuSystem.managedBuffers[buffer.uid]).toBeNull();
    }
    for (const gpuBuffer of gpuBuffers) {
      expect(gpuBuffer.destroy).toHaveBeenCalledTimes(1);
    }
    expect(sharedGroup.getResource(0)).toBe(sharedUniforms);
    expect(sharedUniforms.buffer).toBe(sharedBuffer);
    expect(sharedBuffer.destroyed).toBe(false);
    expect(sharedGpuBuffer.destroy).not.toHaveBeenCalled();
    expect(gpuSystem.managedBuffers[sharedBuffer.uid]).toBe(sharedBuffer);
  });
});

function createResourceOwner() {
  const owner = createPixiIdMaskShaderRenderer({
    ImageSource,
    Mesh,
    MeshGeometry,
    UniformGroup,
    Shader: {
      from(options) {
        // Keep Pixi's real resources and bind groups without creating a GL canvas.
        return Shader.from({
          gpu: options.gpu,
          resources: options.resources,
        });
      },
    },
    mediaWidth: 120,
    mediaHeight: 80,
    packedCoverage: true,
  });
  const uniforms = owner.mesh.shader!.resources.maskUniforms as UniformGroup;
  const descriptorValues = Object.values(uniforms.uniforms);
  const source = owner.mesh.shader!.resources.uTexture as ImageSource;
  const texture = new Texture({ source });
  owner.render(
    {
      fillPalette: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
      strokePalette: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4),
      strokeWidths: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES),
      strokeAlignments: new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES),
      height: 80,
      width: 120,
      hasStroke: true,
      maxStrokeWidth: 1,
    },
    texture,
  );
  const ubo = new GpuUboSystem();
  ubo.updateUniformGroup(uniforms);
  const uniformBuffer = uniforms.buffer!;
  const geometryBuffers = [...owner.mesh.geometry.buffers];
  const gpuSystem = new TestGpuBufferSystem();
  const gpuBuffers = [uniformBuffer, ...geometryBuffers].map((buffer) =>
    gpuSystem.getGPUBuffer(buffer),
  );
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    owner.destroy();
  };
  cleanups.push(() => {
    destroy();
    // Failed teardown assertions must not leave resources alive in the test process.
    uniforms.buffer = undefined;
    for (const buffer of [uniformBuffer, ...geometryBuffers]) {
      if (!buffer.destroyed) buffer.destroy();
    }
    texture.destroy();
    gpuSystem.destroy();
    ubo.destroy();
  });
  return {
    owner,
    uniforms,
    descriptorValues,
    geometryBuffers,
    gpuBuffers,
    gpuSystem,
    source,
    destroy,
  };
}

class TestGpuBufferSystem extends GpuBufferSystem {
  readonly managedBuffers: Record<number, unknown>;

  constructor() {
    let managedBuffers: Record<number, unknown> = {};
    super({
      uid: 147,
      gc: {
        now: 0,
        addResourceHash(hash: { items: Record<number, unknown> }) {
          managedBuffers = hash.items;
        },
      },
    } as unknown as WebGPURenderer);
    this.managedBuffers = managedBuffers;
    this.contextChange({
      device: {
        queue: { writeBuffer() {} },
        createBuffer({ size }: { size: number }) {
          const data = new ArrayBuffer(size);
          return {
            size,
            getMappedRange: () => data,
            unmap() {},
            destroy: vi.fn(),
          };
        },
      },
    } as unknown as GPU);
  }
}

function uniqueArrayBytes(values: readonly unknown[]): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const value of values) {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}
