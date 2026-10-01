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
  BufferImageSource as PixiBufferImageSource,
  Container as PixiContainer,
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
} from "pixi.js";
import type {
  DepthFrameEntry,
  DepthFrameProvider,
} from "#render-preparation/depth/source";
import type {
  InjectedMeshConstructor,
  InjectedMeshGeometryConstructor,
  InjectedShaderFactory,
} from "#renderers/injected-pixi";
import type { ActiveDepthMap } from "#types/media-depth";
import type { ResolvedRenderPreparationGateThresholds } from "#types/render-preparation";
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

/** The frame on screen and the two after it, uploaded ahead while playing. */
const TEXTURE_RING_SIZE = 3;
/**
 * The most frames one present is taken to skip when guessing which frames
 * the next presents draw: 8x on a 60 Hz display skips about three of a
 * 24 fps clip.
 */
const MAX_UPLOAD_STRIDE = 8;
/** Presents the pace is averaged over. */
const PACE_STEPS = 4;
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
  /**
   * Gives a texture its GPU copy now. Pixi otherwise creates one lazily, at
   * the first render that draws it, which is inside a present.
   */
  readonly prepareTexture?: (source: PixiBufferImageSource) => void;
  readonly renderers: readonly DepthAnnotationRenderer[];
  readonly source?: DepthFrameProvider | null;
  /** Whether annotations are hidden, which hides depth as removing its renderers would. */
  readonly hidden?: boolean;
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
  let hidden = options.hidden === true;
  let source = options.source ?? null;
  /**
   * One ring per encoding. Exact and preview maps go up in different texture
   * formats, so sharing slots would destroy a texture of one format to make
   * room for the other, possibly while a shader still holds it.
   */
  const rings = new Map<DepthMap["samples"]["encoding"], DepthTextureRing>();
  let meshOrder = "";
  let meshWidth = 0;
  let meshHeight = 0;
  let nextMapIdentity = 0;
  let active: ActiveDepthMap | null = null;
  let warnedFallback = false;
  let destroyed = false;
  let uploadsInPresent = 0;
  let uploadsAhead = 0;
  /**
   * The clip frame last drawn, and how far presents move. At a rate that is
   * not a whole number of frames a present, a present moves the whole part
   * or one more, and those two frames are what go up ahead.
   */
  let lastFrameIndex: number | null = null;
  /** How far the last few presents that moved went, in frames. */
  const recentSteps: number[] = [];

  const ringFor = (map: DepthMap) => {
    const encoding = map.samples.encoding;
    let ring = rings.get(encoding);

    if (!ring) {
      ring = createDepthTextureRing({
        BufferImageSource: options.BufferImageSource,
        acceptsUnalignedTextureRows: options.acceptsUnalignedTextureRows,
        maxTextureSize: options.maxTextureSize,
        size: TEXTURE_RING_SIZE,
      });
      rings.set(encoding, ring);
    }

    return ring;
  };

  const destroyRings = () => {
    for (const ring of rings.values()) ring.destroy();
    rings.clear();
  };

  /** Gating and prefetching only matter while some renderer draws depth. */
  const drawing = () => renderers.length > 0 && !hidden && !destroyed;

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

    /**
     * Hides depth with the other annotations: nothing draws, the playback
     * gate stops waiting for depth and nothing decodes ahead, as when no
     * depth renderer is set. The source and what it decoded are kept.
     */
    setHidden(next: boolean) {
      hidden = next;
    },

    setDepthSource(next: DepthFrameProvider | null) {
      if (next === source) return;
      source = next;
      hide();
      if (!next) {
        // Nothing will draw from these textures until another map arrives.
        // The shaders let go of them first: Pixi warns about a texture
        // destroyed while a shader still holds it.
        for (const entry of drawn.values()) {
          entry.renderer.clearTexture();
          entry.drawnTexture = null;
        }
        destroyRings();
      }
    },

    drawFrame(mediaTime: number) {
      if (destroyed) return;

      const { height, width } = options.getMediaSize();
      const entry =
        drawing() && width > 0 && height > 0
          ? (source?.getEntry(mediaTime) ?? null)
          : null;

      if (!entry) {
        hide();
        return;
      }

      syncMeshes(width, height);

      const textures = ringFor(entry.map);

      if (!textures.has(entry.map)) uploadsInPresent += 1;

      const texture = textures.acquire(entry.map);

      for (const descriptor of renderers) {
        drawRenderer(entry, texture, descriptor);
      }

      if (entry.frameIndex !== null && entry.frameIndex !== lastFrameIndex) {
        const step =
          lastFrameIndex === null ? 0 : entry.frameIndex - lastFrameIndex;

        // A seek back or a far jump says nothing about the pace.
        if (step > 0 && step <= MAX_UPLOAD_STRIDE) {
          recentSteps.push(step);
          if (recentSteps.length > PACE_STEPS) recentSteps.shift();
        }
        lastFrameIndex = entry.frameIndex;
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

    /** The playhead moved, outside any present: decoding ahead follows it. */
    prefetch(mediaTime: number) {
      if (drawing()) source?.prefetch?.(mediaTime);
    },

    /**
     * Uploads the maps of the next frames into spare textures, so the
     * presents that draw them only bind. Call it after a present, never in
     * one: the frame on screen keeps its own texture.
     */
    uploadAhead(mediaTime: number) {
      if (!drawing() || !source?.getUpcomingEntries) return;

      const upcoming = source.getUpcomingEntries(
        mediaTime,
        TEXTURE_RING_SIZE - 1,
        Math.max(
          1,
          Math.floor(
            recentSteps.reduce((sum, step) => sum + step, 0) /
              Math.max(1, recentSteps.length),
          ),
        ),
      );
      // The frame on screen and the ones about to be: a present repeating
      // the frame on screen must not make the next frames look stale.
      const keep = new Set(upcoming.map(({ map }) => map));

      if (active) keep.add(active.map);

      for (const entry of upcoming) {
        const textures = ringFor(entry.map);

        if (textures.has(entry.map)) continue;

        const slot = textures.acquire(entry.map, keep);

        options.prepareTexture?.(slot.source);
        uploadsAhead += 1;
      }
    },

    needsRenderPreparationWait(
      mediaTime: number,
      thresholds: ResolvedRenderPreparationGateThresholds,
    ): boolean {
      return (
        drawing() &&
        source?.needsPlaybackGateWait?.(mediaTime, thresholds) === true
      );
    },

    waitForRenderPreparation(
      mediaTime: number,
      thresholds: ResolvedRenderPreparationGateThresholds,
      signal?: AbortSignal,
    ): Promise<void> {
      return drawing() && source?.waitForReady
        ? source.waitForReady(mediaTime, thresholds, signal)
        : Promise.resolve();
    },

    getPreparationProgress(): number {
      return source?.getPreparationProgress?.() ?? 0;
    },

    /**
     * Whether the depth a draw of `mediaTime` would show is decoded, asking
     * nothing to load: what the prepared annotation window reads per frame.
     * True where there is nothing to wait for.
     */
    isArtifactPrepared(mediaTime: number): boolean {
      if (!drawing() || !source?.getFrameStatus) return true;

      return source.getFrameStatus(mediaTime)?.prepared !== false;
    },

    /** Maps uploaded while presenting, and ahead of the presents that drew them. */
    getUploadCounts() {
      return { ahead: uploadsAhead, inPresent: uploadsInPresent };
    },

    /** Changes whenever what the layer has on screen changes. */
    getContentKey(): string {
      return active ? `${identify(active.map)}:${active.precision}` : "none";
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyMeshes();
      destroyRings();
      luts.destroy();
      container.destroy();
    },
  };
}

export type PixiDepthLayer = ReturnType<typeof createPixiDepthLayer>;
