import { afterEach, describe, expect, it, vi } from "vitest";

import { annotationRenderers, type DepthMap } from "supervision-js-core";
import type {
  DepthFrameEntry,
  DepthFrameProvider,
} from "#render-preparation/depth-source";
import { createPixiDepthLayer } from "#renderers/pixi-depth-layer";

afterEach(() => {
  vi.unstubAllGlobals();
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

/** One preview frame per second, and the frames after one on demand. */
function previewSource(
  maps: readonly DepthMap[],
  extra: Partial<DepthFrameProvider> = {},
): DepthFrameProvider {
  const entry = (index: number): DepthFrameEntry | null =>
    maps[index]
      ? { frameIndex: index, map: maps[index], precision: "preview" }
      : null;

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

/** Depth for `[0, 1)` and `[1, 2)`, nothing from 2 on. */
function twoFrameSource(first: DepthMap, second: DepthMap): DepthFrameProvider {
  const entry = (map: DepthMap, frameIndex: number): DepthFrameEntry => ({
    frameIndex,
    map,
    precision: "exact",
  });

  return {
    destroy: vi.fn(),
    getEntry: (mediaTime) =>
      mediaTime < 1 ? entry(first, 0) : mediaTime < 2 ? entry(second, 1) : null,
  };
}

function createLayer(
  options: {
    prepareTexture?: (source: unknown) => void;
    maxTextureSize?: number;
    renderers?: Parameters<typeof createPixiDepthLayer>[0]["renderers"];
    source?: DepthFrameProvider | null;
  } = {},
) {
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: vi.fn(), height: 0, width: 0 }),
  });
  const pixi = createFakePixi();
  const layer = createPixiDepthLayer({
    ...pixi.constructors,
    acceptsUnalignedTextureRows: () => false,
    getMediaSize: () => ({ height: 20, width: 40 }),
    maxTextureSize:
      options.maxTextureSize === undefined
        ? undefined
        : () => options.maxTextureSize!,
    prepareTexture: options.prepareTexture as never,
    renderers: options.renderers ?? [annotationRenderers.depth()],
    source: options.source ?? null,
  });

  return { layer, pixi };
}

describe("pixi depth layer", () => {
  it("never draws the previous frame's depth over the next one", () => {
    const first = depthMap(1);
    const { layer, pixi } = createLayer({
      source: twoFrameSource(first, depthMap(2)),
    });

    layer.drawFrame(0.5);
    const mesh = pixi.meshes[0]!;

    expect(mesh.visible).toBe(true);
    expect(layer.getActiveDepth()).toMatchObject({
      frameIndex: 0,
      map: first,
      mediaHeight: 20,
      mediaTime: 0.5,
      mediaWidth: 40,
      precision: "exact",
    });

    layer.drawFrame(2.5);

    expect(mesh.visible).toBe(false);
    expect(layer.getActiveDepth()).toBeNull();
  });

  it("binds each frame's own map", () => {
    const first = depthMap(1);
    const second = depthMap(2);
    const { layer, pixi } = createLayer({
      source: twoFrameSource(first, second),
    });

    layer.drawFrame(0);
    const firstTexture = pixi.shaders[0]!.resources.uDepthTexture;
    layer.drawFrame(1.5);

    expect(pixi.shaders[0]!.resources.uDepthTexture).not.toBe(firstTexture);
    expect(layer.getActiveDepth()?.map).toBe(second);
  });

  it("rewrites uniforms without re-uploading when a renderer changes", () => {
    const { layer, pixi } = createLayer({
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);
    const uploads = pixi.depthUploads();
    const uniforms = pixi.uniformGroups[0]!;

    layer.setRenderers([
      annotationRenderers.depth({ colormap: "viridis", wipe: 0.5 }),
    ]);
    layer.drawFrame(0);

    expect(pixi.depthUploads()).toBe(uploads);
    expect(uploads).toBe(1);
    expect(uniforms.update).toHaveBeenCalledTimes(2);
    expect(uniforms.uniforms.uWipe).toBe(0.5);
    expect(pixi.lutSources()).toBe(2);
  });

  it("writes nothing when the same map is drawn again under the same renderers", () => {
    const { layer, pixi } = createLayer({
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);
    layer.drawFrame(0.25);
    layer.drawFrame(0.75);

    expect(pixi.uniformGroups[0]!.update).toHaveBeenCalledOnce();
  });

  it("shares one upload between two depth renderers", () => {
    const { layer, pixi } = createLayer({
      renderers: [
        annotationRenderers.depth({ id: "left", wipe: 0.5 }),
        annotationRenderers.depth({ colormap: "magma", id: "right" }),
      ],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);

    expect(pixi.meshes).toHaveLength(2);
    expect(pixi.depthUploads()).toBe(1);
    expect(pixi.shaders[0]!.resources.uDepthTexture).toBe(
      pixi.shaders[1]!.resources.uDepthTexture,
    );
    expect(pixi.shaders[0]!.resources.uLutTexture).not.toBe(
      pixi.shaders[1]!.resources.uLutTexture,
    );
  });

  it("stacks one mesh per renderer in presentation order", () => {
    const left = annotationRenderers.depth({ id: "left" });
    const right = annotationRenderers.depth({ id: "right" });
    const { layer, pixi } = createLayer({
      renderers: [left, right],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0);
    const [leftMesh, rightMesh] = pixi.meshes;

    expect(container.children).toEqual([leftMesh, rightMesh]);

    layer.setRenderers([right, left]);
    layer.drawFrame(0);

    expect(container.children).toEqual([rightMesh, leftMesh]);

    layer.setRenderers([right]);
    layer.drawFrame(0);

    expect(container.children).toEqual([rightMesh]);
    expect(leftMesh!.destroy).toHaveBeenCalledOnce();
  });

  it("carries opacity on the mesh, clamped to 0..1", () => {
    const { layer, pixi } = createLayer({
      renderers: [annotationRenderers.depth({ opacity: 1.5 })],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);
    expect(pixi.meshes[0]!.alpha).toBe(1);

    layer.setRenderers([annotationRenderers.depth({ opacity: 0.3 })]);
    layer.drawFrame(0);
    expect(pixi.meshes[0]!.alpha).toBe(0.3);
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

  it("names what is on screen in its content key", () => {
    const { layer } = createLayer({
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    expect(layer.getContentKey()).toBe("none");
    layer.drawFrame(0);
    const first = layer.getContentKey();
    layer.drawFrame(0.5);
    expect(layer.getContentKey()).toBe(first);
    layer.drawFrame(1.5);
    expect(layer.getContentKey()).not.toBe(first);
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

    layer.drawFrame(0);
    expect(pixi.meshes[0]!.visible).toBe(false);
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

  it("uploads the next frames ahead, so the presents that draw them only bind", () => {
    const maps = [
      previewMap(20),
      previewMap(30),
      previewMap(40),
      previewMap(50),
    ];
    const prepared: unknown[] = [];
    const { layer, pixi } = createLayer({
      prepareTexture: (source) => prepared.push(source),
      source: previewSource(maps),
    });

    layer.drawFrame(0);
    layer.uploadAhead(0);
    const sources = pixi.depthUploads();

    layer.drawFrame(1);
    layer.drawFrame(2);

    expect(pixi.depthUploads()).toBe(sources);
    expect(prepared).toHaveLength(2);
    expect(layer.getUploadCounts()).toEqual({ ahead: 2, inPresent: 1 });
    expect(layer.getActiveDepth()).toMatchObject({
      frameIndex: 2,
      precision: "preview",
    });
  });

  it("uploads ahead the frames a fast rate will present, not the ones it skips", () => {
    const maps = Array.from({ length: 12 }, (_, index) =>
      previewMap(20 + index),
    );
    const skips: (number | undefined)[] = [];
    const source = previewSource(maps);
    const upcoming = source.getUpcomingEntries!;

    source.getUpcomingEntries = (mediaTime, count, skip) => {
      skips.push(skip);
      return upcoming(mediaTime, count);
    };

    const { layer } = createLayer({ source });

    layer.drawFrame(0);
    layer.drawFrame(3);
    layer.uploadAhead(3);
    layer.drawFrame(3.5);
    layer.uploadAhead(3.5);

    expect(skips).toEqual([3, 3]);
  });

  it("uploads both frames an 8x present can land on", () => {
    const maps = Array.from({ length: 40 }, (_, index) =>
      previewMap(20 + index),
    );
    const { layer } = createLayer({ source: previewSource(maps) });

    // A 24 fps clip at 8x on 60 Hz moves 3.2 frames a present.
    for (const frame of [0, 3, 6, 10, 13, 16, 19, 22, 26, 29, 32]) {
      layer.drawFrame(frame);
      layer.uploadAhead(frame);
    }

    // The first frame, and the first jump before the layer knows the pace.
    expect(layer.getUploadCounts().inPresent).toBe(2);
  });

  it("keeps frames uploaded ahead through a present that repeats the frame on screen", () => {
    const maps = Array.from({ length: 8 }, (_, index) =>
      previewMap(20 + index),
    );
    const { layer } = createLayer({ source: previewSource(maps) });

    // 48 fps on a 60 Hz display: every fifth present repeats its frame.
    for (const time of [0, 1, 2, 2.5, 3, 4, 4.5, 5]) {
      layer.drawFrame(time);
      layer.uploadAhead(time);
    }

    expect(layer.getUploadCounts().inPresent).toBe(1);
  });

  it("never uploads over the texture on screen while uploading ahead", () => {
    const maps = Array.from({ length: 8 }, (_, index) =>
      previewMap(20 + index),
    );
    const { layer, pixi } = createLayer({ source: previewSource(maps) });

    for (let frame = 0; frame < 6; frame += 1) {
      layer.drawFrame(frame);
      layer.uploadAhead(frame);

      const bound = pixi.shaders[0]!.resources.uDepthTexture as {
        readonly update: ReturnType<typeof vi.fn>;
      };
      const updates = bound.update.mock.calls.length;

      layer.uploadAhead(frame);
      expect(bound.update.mock.calls.length).toBe(updates);
    }
  });

  it("keeps exact and preview textures apart, so a swap destroys none", () => {
    const exact = depthMap(1);
    const preview = previewMap(40);
    let precision: "exact" | "preview" = "exact";
    const { layer, pixi } = createLayer({
      source: {
        destroy: vi.fn(),
        getEntry: () =>
          precision === "exact"
            ? { frameIndex: 0, map: exact, precision }
            : { frameIndex: 0, map: preview, precision },
      },
    });

    for (const next of ["exact", "preview", "exact", "preview"] as const) {
      precision = next;
      layer.drawFrame(0);
    }

    expect(pixi.depthUploads()).toBe(2);
    expect(
      pixi.depthSources.every(({ destroy }) => !destroy.mock.calls.length),
    ).toBe(true);
    expect(layer.getContentKey()).toContain("preview");
  });

  it("waits for depth and prefetches it only while a depth renderer draws", () => {
    const thresholds = { resumeAtSeconds: 0.3, stopBelowSeconds: 0.1 };
    const needsPlaybackGateWait = vi.fn(() => true);
    const waitForReady = vi.fn(async () => undefined);
    const prefetch = vi.fn();
    const source = previewSource([previewMap(20)], {
      getPreparationProgress: () => 7,
      needsPlaybackGateWait,
      prefetch,
      waitForReady,
    });
    const { layer } = createLayer({ source });

    expect(layer.needsRenderPreparationWait(0, thresholds)).toBe(true);
    void layer.waitForRenderPreparation(0, thresholds);
    layer.prefetch(2);
    expect(waitForReady).toHaveBeenCalledOnce();
    expect(prefetch).toHaveBeenCalledWith(2);
    expect(layer.getPreparationProgress()).toBe(7);

    layer.setRenderers([]);
    expect(layer.needsRenderPreparationWait(0, thresholds)).toBe(false);
    void layer.waitForRenderPreparation(0, thresholds);
    layer.prefetch(3);
    expect(waitForReady).toHaveBeenCalledOnce();
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("draws nothing without a depth renderer", () => {
    const { layer, pixi } = createLayer({
      renderers: [],
      source: twoFrameSource(depthMap(1), depthMap(2)),
    });

    layer.drawFrame(0);

    expect(pixi.meshes).toHaveLength(0);
    expect(pixi.depthUploads()).toBe(0);
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
    bufferSources,
    get depthSources() {
      return bufferSources.filter(
        ({ options }) => options.format !== "rgba8unorm",
      );
    },
    depthUploads: () =>
      bufferSources.filter(({ options }) => options.format !== "rgba8unorm")
        .length,
    lutSources: () =>
      bufferSources.filter(({ options }) => options.format === "rgba8unorm")
        .length,
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
