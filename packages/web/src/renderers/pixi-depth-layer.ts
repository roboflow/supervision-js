import {
  computeDepthPercentileRange,
  resolveDepthColorMapping,
  resolveDepthQuantity,
  type DepthAnnotationRenderer,
  type DepthMap,
  type DepthQuantity,
  type DepthRange,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
} from "pixi.js";
import type {
  DepthFrameEntry,
  DepthFrameProvider,
} from "#render-preparation/depth-source";
import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "#renderers/injected-pixi";
import type { ActiveDepthMap } from "#types/media-depth";
import {
  createDepthLutCache,
  createDepthTextureRing,
  type DepthBufferImageSourceConstructor,
  type DepthTextureRing,
  type DepthTextureSlot,
} from "./depth-textures";
import {
  createPixiDepthShaderRenderer,
  resolveDepthShaderUniforms,
  type PixiDepthShaderRenderer,
} from "./pixi-depth-shader";

type PixiDepthMesh = PixiMesh<PixiMeshGeometry, PixiShader>;
type DepthShaderOptions = Parameters<typeof createPixiDepthShaderRenderer>[0];

interface DrawnDepth {
  readonly renderer: PixiDepthShaderRenderer;
  drawnMap: DepthMap | null;
  drawnDescriptor: DepthAnnotationRenderer | null;
  drawnTexture: DepthTextureSlot | null;
}

/**
 * Draws the session's depth under every depth renderer.
 *
 * All renderers share one upload of each map; a renderer change rewrites the
 * shader's uniforms and uploads nothing. The draw reads only the media time it
 * is given, and a time with no map hides every mesh rather than leaving the
 * previous map over new pixels.
 */
export function createPixiDepthLayer(options: {
  readonly BufferImageSource: DepthBufferImageSourceConstructor;
  readonly Container: new () => PixiContainer;
  readonly ImageSource: DepthShaderOptions["ImageSource"];
  readonly Mesh: InjectedMeshConstructor<PixiDepthMesh>;
  readonly MeshGeometry: InjectedMeshGeometryConstructor;
  readonly Shader: InjectedShaderFactory;
  readonly UniformGroup: DepthShaderOptions["UniformGroup"];
  readonly acceptsUnalignedTextureRows: () => boolean;
  /** The GPU's largest texture side, asked once per backend. */
  readonly maxTextureSize?: () => number;
  readonly getMediaSize: () => { width: number; height: number };
  readonly renderers: readonly DepthAnnotationRenderer[];
  readonly source?: DepthFrameProvider | null;
}) {
  const container = new options.Container();
  const luts = createDepthLutCache(options.BufferImageSource);
  const drawn = new Map<string, DrawnDepth>();
  const autoRanges = new WeakMap<
    DepthMap,
    Map<DepthQuantity, DepthRange | null>
  >();
  const mapIdentities = new WeakMap<DepthMap, number>();
  let renderers = options.renderers;
  let source = options.source ?? null;
  let ring: DepthTextureRing | undefined;
  let meshOrder = "";
  let meshWidth = 0;
  let meshHeight = 0;
  let nextMapIdentity = 0;
  let active: ActiveDepthMap | null = null;
  let warnedFallback = false;
  let destroyed = false;

  const hide = () => {
    for (const entry of drawn.values()) entry.renderer.hide();
    active = null;
  };

  const destroyMeshes = () => {
    for (const entry of drawn.values()) {
      entry.renderer.mesh.removeFromParent();
      entry.renderer.destroy();
    }
    drawn.clear();
    meshOrder = "";
  };

  /** One mesh per renderer id, stacked in presentation order. */
  const syncMeshes = (width: number, height: number) => {
    if (width !== meshWidth || height !== meshHeight) {
      destroyMeshes();
      meshWidth = width;
      meshHeight = height;
    }

    const ids = new Set(renderers.map(({ id }) => id));

    for (const [id, entry] of drawn) {
      if (ids.has(id)) continue;
      entry.renderer.mesh.removeFromParent();
      entry.renderer.destroy();
      drawn.delete(id);
    }

    for (const { id } of renderers) {
      if (drawn.has(id)) continue;
      drawn.set(id, {
        drawnDescriptor: null,
        drawnMap: null,
        drawnTexture: null,
        renderer: createPixiDepthShaderRenderer({
          ImageSource: options.ImageSource,
          Mesh: options.Mesh,
          MeshGeometry: options.MeshGeometry,
          Shader: options.Shader,
          UniformGroup: options.UniformGroup,
          mediaHeight: height,
          mediaWidth: width,
        }),
      });
    }

    const order = renderers.map(({ id }) => id).join("\n");

    if (order !== meshOrder) {
      // Adding a child it already holds moves it to the top.
      for (const { id } of renderers) {
        container.addChild(drawn.get(id)!.renderer.mesh);
      }
      meshOrder = order;
    }
  };

  /**
   * A frame's percentile range is a function of the frame alone, so it is
   * computed once per map and quantity rather than once per draw.
   */
  const autoRangeFor = (
    map: DepthMap,
    renderer: DepthAnnotationRenderer,
  ): DepthRange | null | undefined => {
    const range = renderer.range ?? "clip";

    if (typeof range === "object" || (range === "clip" && map.displayRange)) {
      return undefined;
    }

    const { quantity } = resolveDepthQuantity(
      map.kind,
      renderer.quantity,
      map.camera,
    );
    let ranges = autoRanges.get(map);

    if (!ranges) {
      ranges = new Map();
      autoRanges.set(map, ranges);
    }
    if (!ranges.has(quantity)) {
      ranges.set(quantity, computeDepthPercentileRange(map, { quantity }));
    }

    return ranges.get(quantity);
  };

  const drawRenderer = (
    entry: DepthFrameEntry,
    texture: DepthTextureSlot,
    descriptor: DepthAnnotationRenderer,
  ) => {
    const target = drawn.get(descriptor.id)!;

    target.renderer.setOpacity(
      Math.min(1, Math.max(0, descriptor.opacity ?? 1)),
    );

    if (
      target.drawnMap === entry.map &&
      target.drawnDescriptor === descriptor &&
      target.drawnTexture === texture
    ) {
      target.renderer.mesh.visible = true;
      return;
    }

    const mapping = resolveDepthColorMapping(
      entry.map,
      descriptor,
      autoRangeFor(entry.map, descriptor),
    );

    if (mapping.fellBack && !warnedFallback) {
      warnedFallback = true;
      console.warn(
        `Depth renderer "${descriptor.id}" colours disparity: depth needs a metric map or a camera.`,
      );
    }

    target.renderer.render(
      texture.source,
      luts.get(descriptor.colormap ?? "turbo"),
      resolveDepthShaderUniforms(
        entry.map,
        mapping,
        descriptor,
        { height: meshHeight, width: meshWidth },
        texture.displaySize,
      ),
    );
    target.drawnDescriptor = descriptor;
    target.drawnMap = entry.map;
    target.drawnTexture = texture;
  };

  const identify = (map: DepthMap) => {
    let identity = mapIdentities.get(map);

    if (identity === undefined) {
      identity = ++nextMapIdentity;
      mapIdentities.set(map, identity);
    }

    return identity;
  };

  return {
    createContainer: () => container,

    setRenderers(next: readonly DepthAnnotationRenderer[]) {
      renderers = next;
    },

    setDepthSource(next: DepthFrameProvider | null) {
      if (next === source) return;
      source = next;
      hide();
      if (!next) {
        // Nothing will draw from these textures until another map arrives.
        ring?.destroy();
        ring = undefined;
        for (const entry of drawn.values()) {
          entry.renderer.clearTexture();
          entry.drawnTexture = null;
        }
      }
    },

    drawFrame(mediaTime: number) {
      if (destroyed) return;

      const { height, width } = options.getMediaSize();
      const entry =
        renderers.length > 0 && width > 0 && height > 0
          ? (source?.getEntry(mediaTime) ?? null)
          : null;

      if (!entry) {
        hide();
        return;
      }

      syncMeshes(width, height);
      ring ??= createDepthTextureRing({
        BufferImageSource: options.BufferImageSource,
        acceptsUnalignedTextureRows: options.acceptsUnalignedTextureRows,
        maxTextureSize: options.maxTextureSize,
      });

      const texture = ring.acquire(entry.map);

      for (const descriptor of renderers) {
        drawRenderer(entry, texture, descriptor);
      }

      active = {
        frameIndex: entry.frameIndex,
        map: entry.map,
        mediaHeight: height,
        mediaTime,
        mediaWidth: width,
        precision: entry.precision,
      };
    },

    getActiveDepth(): ActiveDepthMap | null {
      return active;
    },

    /** Changes whenever what the layer has on screen changes. */
    getContentKey(): string {
      return active ? `${identify(active.map)}:${active.precision}` : "none";
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyMeshes();
      ring?.destroy();
      luts.destroy();
      container.destroy();
    },
  };
}

export type PixiDepthLayer = ReturnType<typeof createPixiDepthLayer>;
