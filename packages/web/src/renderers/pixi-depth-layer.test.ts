import { afterEach, describe, expect, it, vi } from "vitest";

import { annotationRenderers, type DepthMap } from "supervision-js-core";
import type {
  DepthFrameEntry,
  DepthFrameProvider,
} from "#render-preparation/depth/source";
import { createPixiDepthLayer } from "#renderers/pixi-depth-layer";

afterEach(() => {
  vi.restoreAllMocks();
});

function depthMap(first: number): DepthMap {
  return {
    displayRange: { max: 100, min: 1 },
    height: 2,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: 256,
      values: Uint16Array.from([first, 256, 512, 1024, 0, 2048, 4096, 8192]),
    },
    width: 4,
  };
}

function previewMap(code: number): DepthMap {
  return {
    height: 2,
    kind: "disparity_px",
    samples: {
      encoding: "preview8",
      range: { max: 100, min: 0 },
      reservedMax: 15,
      values: new Uint8Array(8).fill(code),
    },
    width: 4,
  };
}

/** One preview frame per second. */
function previewSource(
  maps: readonly DepthMap[],
  extra: Partial<DepthFrameProvider> = {},
): DepthFrameProvider {
  const entry = (index: number): DepthFrameEntry | null =>
    maps[index] ? { frameIndex: index, map: maps[index] } : null;

  return {
    destroy: vi.fn(),
    getEntry: (mediaTime) => entry(Math.floor(mediaTime)),
    getUpcomingEntries: (mediaTime, count, skip = 1) =>
      Array.from({ length: count }, (_, step) =>
        entry(Math.floor(mediaTime) + skip + step),
      ).filter((found): found is DepthFrameEntry => found !== null),
    ...extra,
  };
}

function twoFrameSource(first: DepthMap, second: DepthMap): DepthFrameProvider {
  const entry = (map: DepthMap, frameIndex: number): DepthFrameEntry => ({
    frameIndex,
    map,
  });

  return {
    destroy: vi.fn(),
    getEntry: (mediaTime) =>
      mediaTime < 1 ? entry(first, 0) : mediaTime < 2 ? entry(second, 1) : null,
  };
}

function createLayer(
  options: {
    maxTextureSize?: number;
    renderers?: Parameters<typeof createPixiDepthLayer>[0]["renderers"];
    source?: DepthFrameProvider | null;
    hidden?: boolean;
  } = {},
) {
  const pixi = createFakePixi();
  const layer = createPixiDepthLayer({
    ...pixi.constructors,
    acceptsUnalignedTextureRows: () => false,
    hidden: options.hidden,
    getMediaSize: () => ({ height: 20, width: 40 }),
    maxTextureSize:
      options.maxTextureSize === undefined
        ? undefined
        : () => options.maxTextureSize!,
    renderers: options.renderers ?? [annotationRenderers.depth()],
    source: options.source ?? null,
  });

  return { layer, pixi };
}

describe("pixi depth layer", () => {
  it("binds each frame's own map, and none where a frame has no depth", () => {
    const first = depthMap(1);
    const second = depthMap(2);
    const { layer, pixi } = createLayer({
      source: twoFrameSource(first, second),
    });

    layer.drawFrame(0.5);
    const mesh = pixi.meshes[0]!;
    const firstTexture = pixi.shaders[0]!.resources.uDepthTexture;

    expect(mesh.visible).toBe(true);
    expect(layer.getActiveDepth()).toMatchObject({
      frameIndex: 0,
      map: first,
      mediaHeight: 20,
      mediaTime: 0.5,
      mediaWidth: 40,
      precision: "exact",
    });

    layer.drawFrame(1.5);
    expect(pixi.shaders[0]!.resources.uDepthTexture).not.toBe(firstTexture);
    expect(layer.getActiveDepth()?.map).toBe(second);

    layer.drawFrame(2.5);
    expect(mesh.visible).toBe(false);
    expect(layer.getActiveDepth()).toBeNull();
  });

  it("stacks one mesh per renderer in presentation order, at its opacity", () => {
    const left = annotationRenderers.depth({ id: "left", opacity: 0.3 });
    const right = annotationRenderers.depth({ id: "right" });
    const { layer, pixi } = createLayer({
      renderers: [left, right],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    const [leftMesh, rightMesh] = pixi.meshes;

    expect(container.children).toEqual([leftMesh, rightMesh]);
    expect(leftMesh!.alpha).toBe(0.3);

    layer.setRenderers([right, left]);
    layer.drawFrame(0);

    expect(container.children).toEqual([rightMesh, leftMesh]);

    layer.setRenderers([right]);
    layer.drawFrame(0);

    expect(container.children).toEqual([rightMesh]);
    expect(leftMesh!.destroy).toHaveBeenCalledOnce();
  });

  it("warns once when depth has to fall back to disparity", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { layer } = createLayer({
      renderers: [annotationRenderers.depth({ quantity: "depth" })],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);
    layer.drawFrame(1.5);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('Depth renderer "depth"');
  });

  it("hides and releases its textures when depth is removed", () => {
    const { layer, pixi } = createLayer({
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);
    const uploaded = pixi.depthSources[0]!;
    let boundWhenDestroyed: unknown;

    uploaded.destroy.mockImplementation(() => {
      boundWhenDestroyed = pixi.shaders[0]!.resources.uDepthTexture;
    });
    layer.setDepthSource(null);

    expect(pixi.meshes[0]!.visible).toBe(false);
    expect(layer.getActiveDepth()).toBeNull();
    expect(uploaded.destroy).toHaveBeenCalledOnce();
    // The shader let go of the texture before it was destroyed.
    expect(boundWhenDestroyed).toBeDefined();
    expect(boundWhenDestroyed).not.toBe(uploaded);
  });

  it("draws a map too large for the GPU decimated, and reads it back whole", () => {
    const map = depthMap(1);
    const { layer, pixi } = createLayer({
      maxTextureSize: 2,
      source: twoFrameSource(map, map),
    });

    layer.drawFrame(0);

    expect(pixi.depthSources[0]!.options).toMatchObject({ height: 1 });
    expect(
      Array.from(pixi.uniformGroups[0]!.uniforms.uMapSize as Float32Array),
    ).toEqual([2, 1]);
    // Smaller than the media, so "auto" sampling filters edge-aware.
    expect(pixi.uniformGroups[0]!.uniforms.uSampling).toBe(1);
    expect(layer.getActiveDepth()?.map).toBe(map);
  });

  it.each([
    // 48 fps on a 60 Hz display: every fifth present repeats its frame.
    ["a present that repeats its frame", [0, 1, 2, 2.5, 3, 4, 4.5, 5], 1],
    // A 24 fps clip at 8x on 60 Hz moves 3.2 frames a present; the first
    // jump comes before the layer knows the pace.
    ["an 8x rate", [0, 3, 6, 10, 13, 16, 19, 22, 26, 29, 32], 2],
  ])(
    "uploads ahead the frames %s lands on, never over the texture on screen",
    (_, times, inPresent) => {
      const maps = Array.from({ length: 40 }, (_, index) =>
        previewMap(20 + index),
      );
      const { layer, pixi } = createLayer({ source: previewSource(maps) });

      for (const time of times) {
        layer.drawFrame(time);
        layer.uploadAhead(time);

        const bound = pixi.shaders[0]!.resources.uDepthTexture as {
          readonly update: ReturnType<typeof vi.fn>;
        };
        const updates = bound.update.mock.calls.length;

        layer.uploadAhead(time);
        expect(bound.update.mock.calls.length).toBe(updates);
        expect(layer.getActiveDepth()).toMatchObject({
          map: maps[Math.floor(time)],
          precision: "preview",
        });
      }

      expect(layer.getUploadCounts().inPresent).toBe(inPresent);
    },
  );

  it("holds playback for depth only while a depth renderer shows it", () => {
    const thresholds = { resumeAtSeconds: 0.3, stopBelowSeconds: 0.1 };
    const source = previewSource([previewMap(20)], {
      getFrameStatus: () => ({ frameIndex: 0, prepared: false }),
      needsPlaybackGateWait: () => true,
    });
    const { layer } = createLayer({ hidden: true, source });

    expect(layer.needsRenderPreparationWait(0, thresholds)).toBe(false);
    expect(layer.isArtifactPrepared(0)).toBe(true);

    layer.setHidden(false);
    expect(layer.needsRenderPreparationWait(0, thresholds)).toBe(true);
    expect(layer.isArtifactPrepared(0)).toBe(false);

    layer.setRenderers([]);
    expect(layer.needsRenderPreparationWait(0, thresholds)).toBe(false);
    expect(layer.isArtifactPrepared(0)).toBe(true);
  });
});

class FakeContainer {
  children: FakeMesh[] = [];
  readonly destroy = vi.fn();

  addChild(child: FakeMesh) {
    child.removeFromParent();
    this.children.push(child);
    child.parent = this;
  }
}

class FakeMesh {
  alpha = 1;
  parent?: FakeContainer;
  shader: FakeShader;
  visible = true;
  readonly destroy = vi.fn();

  constructor(options: { shader: FakeShader }) {
    this.shader = options.shader;
  }

  removeFromParent() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(
      (child) => child !== this,
    );
    this.parent = undefined;
  }
}

class FakeShader {
  constructor(readonly resources: Record<string, unknown>) {}

  readonly destroy = vi.fn();
}

interface FakeUniformGroup {
  readonly uniforms: Record<string, unknown>;
  readonly update: ReturnType<typeof vi.fn>;
}

interface FakeBufferSource {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly options: { readonly format: string };
  readonly style: object;
}

function createFakePixi() {
  const meshes: FakeMesh[] = [];
  const shaders: FakeShader[] = [];
  const uniformGroups: FakeUniformGroup[] = [];
  const bufferSources: FakeBufferSource[] = [];

  return {
    get depthSources() {
      return bufferSources.filter(
        ({ options }) => options.format !== "rgba8unorm",
      );
    },
    meshes,
    shaders,
    uniformGroups,
    constructors: {
      BufferImageSource: class {
        readonly destroy = vi.fn();
        readonly style = {};
        readonly update = vi.fn();

        constructor(readonly options: { readonly format: string }) {
          bufferSources.push(this);
        }
      } as never,
      Container: FakeContainer as never,
      ImageSource: class {
        readonly destroy = vi.fn();
        readonly style = {};
      } as never,
      Mesh: class extends FakeMesh {
        constructor(options: { shader: FakeShader }) {
          super(options);
          meshes.push(this);
        }
      } as never,
      MeshGeometry: class {
        readonly destroy = vi.fn();
      } as never,
      Shader: {
        from(options: { resources: Record<string, unknown> }) {
          const shader = new FakeShader({ ...options.resources });

          shaders.push(shader);
          return shader;
        },
      } as never,
      UniformGroup: class {
        readonly uniforms: Record<string, unknown> = {};
        readonly update = vi.fn();

        constructor(uniforms: Record<string, { value: unknown }>) {
          for (const [key, { value }] of Object.entries(uniforms)) {
            this.uniforms[key] = value;
          }
          uniformGroups.push(this);
        }
      } as never,
    },
  };
}
