import type {
  AnnotationStyleContext,
  BufferedDetectionTimeline,
  Detection,
  DetectionFrame,
  Rect,
  RegionAnnotationRenderer,
  RegionRendererRegion,
} from "supervision-js-core";
import { RegionRendererSourceKind } from "supervision-js-core";
import type {
  Container as PixiContainer,
  Rectangle as PixiRectangle,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";
import type {
  GifSource as PixiGifSource,
  GifSprite as PixiGifSprite,
} from "pixi.js/gif";

type RegionAsset = PixiTexture | PixiGifSource;
type RegionDisplay = PixiSprite | PixiGifSprite;

interface TopLeftCrop {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface RegionAssetLoader {
  load<T = RegionAsset>(src: string): Promise<T>;
  unload(src: string): Promise<void>;
}

interface RegionSpriteEntry {
  readonly display: RegionDisplay;
  readonly ownedTexture?: PixiTexture;
  readonly rendererId: string;
  readonly sourceKey: string;
  active: boolean;
  baseX: number;
  baseY: number;
  detectionId: string | number | undefined;
}

interface RegionAssetLease {
  readonly asset: Promise<RegionAsset>;
  release(): void;
}

interface SharedAssetEntry {
  readonly asset: Promise<RegionAsset>;
  references: number;
}

const sharedAssets = new WeakMap<object, Map<string, SharedAssetEntry>>();

export interface PixiRegionLayerState {
  readonly activeDetectionIndexes: readonly number[];
}

export interface PixiRegionLayer {
  createContainer(): PixiContainer;
  drawFrame(mediaTime: number, viewportScale?: number): PixiRegionLayerState;
  setRenderers(renderers: readonly RegionAnnotationRenderer[]): void;
  translateDetection(id: string | number, x: number, y: number): boolean;
  destroy(): void;
}

/** Browser implementation for asset- and media-backed region descriptors. */
export function createPixiRegionLayer(options: {
  readonly Assets: RegionAssetLoader;
  readonly Container: new () => PixiContainer;
  readonly GifSprite: new (options: {
    readonly autoPlay?: boolean;
    readonly loop?: boolean;
    readonly source: PixiGifSource;
  }) => PixiGifSprite;
  readonly Rectangle: new (
    x?: number,
    y?: number,
    width?: number,
    height?: number,
  ) => PixiRectangle;
  readonly Sprite: new (options: { texture: PixiTexture }) => PixiSprite;
  readonly Texture: new (options: {
    readonly dynamic?: boolean;
    readonly frame?: PixiRectangle;
    readonly source: PixiTexture["source"];
  }) => PixiTexture;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly getMediaTexture: () => PixiTexture | undefined;
  readonly onInvalidate?: () => void;
  readonly onAssetError?: (options: {
    readonly error: unknown;
    readonly rendererId: string;
    readonly src: string;
  }) => void;
  readonly regionRenderers: readonly RegionAnnotationRenderer[];
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
}): PixiRegionLayer {
  let container: PixiContainer | undefined;
  let currentFrame: DetectionFrame | undefined;
  let currentMediaTime = 0;
  let currentViewportScale = 1;
  let destroyed = false;
  let renderers = [...options.regionRenderers];
  const assets = new Map<
    string,
    {
      readonly src: string;
      readonly lease: RegionAssetLease;
      asset?: RegionAsset;
    }
  >();
  const entries = new Map<string, RegionSpriteEntry>();
  const pools = new Map<string, RegionSpriteEntry[]>();
  const sourceKeys = new Map<string, string>();

  syncSources();

  return {
    createContainer() {
      if (!container) {
        container = new options.Container();
        container.sortableChildren = true;
      }
      return container;
    },

    drawFrame(mediaTime, viewportScale = 1) {
      currentMediaTime = mediaTime;
      currentViewportScale = viewportScale;
      currentFrame = options.detectionTimeline.selectFrame(mediaTime);
      const activeKeys = new Set<string>();
      const activeDetectionIndexes = new Set<number>();

      for (const entry of entries.values()) entry.active = false;

      if (currentFrame) {
        for (const [rendererIndex, renderer] of renderers.entries()) {
          const sourceKey = sourceKeys.get(renderer.id);
          if (!sourceKey) continue;
          const asset =
            renderer.source.kind === RegionRendererSourceKind.Asset
              ? assets.get(renderer.id)?.asset
              : undefined;
          const mediaTexture =
            renderer.source.kind === RegionRendererSourceKind.Media
              ? options.getMediaTexture()
              : undefined;
          if (
            (renderer.source.kind === RegionRendererSourceKind.Asset &&
              !asset) ||
            (renderer.source.kind === RegionRendererSourceKind.Media &&
              !mediaTexture)
          ) {
            continue;
          }

          for (const [
            detectionIndex,
            detection,
          ] of currentFrame.detections.entries()) {
            const context: AnnotationStyleContext = {
              detectionIndex,
              frame: currentFrame,
              mediaTime,
              viewportScale,
              ...options.resolveContextState?.(detection),
            };
            if (
              context.hidden ||
              !matchesTarget(renderer, detection, context)
            ) {
              continue;
            }

            const region = resolveRegion(renderer.region, detection);
            if (!region) continue;

            const key = resolveSpriteKey(
              renderer.id,
              detection,
              detectionIndex,
            );
            let entry: RegionSpriteEntry;
            let sourceSize: { readonly height: number; readonly width: number };

            if (
              renderer.source.kind === RegionRendererSourceKind.Asset &&
              asset
            ) {
              entry = ensureAssetEntry(
                key,
                renderer.id,
                sourceKey,
                asset,
                detection.id,
              );
              sourceSize = asset;
            } else if (
              renderer.source.kind === RegionRendererSourceKind.Media &&
              mediaTexture
            ) {
              const sourceRegion = resolveRegion(
                renderer.source.region,
                detection,
              );
              const crop = sourceRegion
                ? resolveMediaCrop(sourceRegion, mediaTexture)
                : undefined;
              if (!crop) continue;
              entry = ensureMediaEntry(
                key,
                renderer.id,
                sourceKey,
                mediaTexture,
                crop,
                detection.id,
              );
              sourceSize = entry.ownedTexture!;
            } else {
              continue;
            }

            const position = positionSprite(
              entry.display,
              renderer,
              region,
              sourceSize,
            );
            entry.baseX = position.x;
            entry.baseY = position.y;
            entry.detectionId = detection.id;
            entry.display.zIndex =
              (renderer.compose?.zIndex ?? 0) * 1_000_000 +
              rendererIndex * 10_000 +
              (detection.zIndex ?? detectionIndex);
            entry.display.visible = true;
            entry.active = true;
            activeKeys.add(key);
            activeDetectionIndexes.add(detectionIndex);
          }
        }
      }

      for (const [key, entry] of entries) {
        if (activeKeys.has(key)) continue;
        entry.display.visible = false;
        pauseAnimatedDisplay(entry.display);
        entries.delete(key);
        const poolKey = resolvePoolKey(entry.rendererId, entry.sourceKey);
        const pool = pools.get(poolKey) ?? [];
        pool.push(entry);
        pools.set(poolKey, pool);
      }

      return { activeDetectionIndexes: [...activeDetectionIndexes] };
    },

    setRenderers(nextRenderers) {
      renderers = [...nextRenderers];
      syncSources();
      this.drawFrame(currentMediaTime, currentViewportScale);
    },

    translateDetection(id, x, y) {
      let translated = false;
      for (const entry of entries.values()) {
        if (!entry.active || entry.detectionId !== id) continue;
        entry.display.position.set(entry.baseX + x, entry.baseY + y);
        translated = true;
      }
      return translated;
    },

    destroy() {
      destroyed = true;
      destroyAllDisplays();
      for (const asset of assets.values()) asset.lease.release();
      assets.clear();
      container = undefined;
      currentFrame = undefined;
      sourceKeys.clear();
    },
  };

  function syncSources() {
    const desiredSourceKeys = new Map(
      renderers.map((renderer) => [renderer.id, resolveSourceKey(renderer)]),
    );

    for (const [rendererId, sourceKey] of sourceKeys) {
      if (desiredSourceKeys.get(rendererId) === sourceKey) continue;
      destroyRendererDisplays(rendererId);
    }

    sourceKeys.clear();
    for (const [rendererId, sourceKey] of desiredSourceKeys) {
      sourceKeys.set(rendererId, sourceKey);
    }
    syncAssets();
  }

  function syncAssets() {
    const desired = new Map(
      renderers.flatMap((renderer) =>
        renderer.source.kind === RegionRendererSourceKind.Asset
          ? [[renderer.id, renderer.source.asset.src] as const]
          : [],
      ),
    );

    for (const [id, asset] of assets) {
      if (desired.get(id) === asset.src) continue;
      destroyRendererDisplays(id);
      asset.lease.release();
      assets.delete(id);
    }

    for (const [id, src] of desired) {
      if (assets.has(id)) continue;
      const lease = acquireAsset(options.Assets, src);
      const asset: {
        readonly src: string;
        readonly lease: RegionAssetLease;
        asset?: RegionAsset;
      } = { lease, src };
      assets.set(id, asset);
      void lease.asset.then(
        (loadedAsset) => {
          if (destroyed || assets.get(id) !== asset) return;
          asset.asset = loadedAsset;
          options.onInvalidate?.();
        },
        (error) => {
          // A failed asset is omitted. Replacing the descriptor retries it.
          options.onAssetError?.({ error, rendererId: id, src });
        },
      );
    }
  }

  function ensureAssetEntry(
    key: string,
    rendererId: string,
    sourceKey: string,
    asset: RegionAsset,
    detectionId: string | number | undefined,
  ) {
    let entry = entries.get(key);
    if (entry) return entry;

    const poolKey = resolvePoolKey(rendererId, sourceKey);
    const pool = pools.get(poolKey);
    entry = pool?.pop();
    if (pool?.length === 0) pools.delete(poolKey);
    if (entry) {
      entry.detectionId = detectionId;
      resumeAnimatedDisplay(entry.display);
    } else {
      const display = isGifSource(asset)
        ? new options.GifSprite({ autoPlay: true, loop: true, source: asset })
        : new options.Sprite({ texture: asset });
      display.anchor.set(0.5);
      container?.addChild(display);
      entry = {
        active: false,
        baseX: 0,
        baseY: 0,
        detectionId,
        display,
        rendererId,
        sourceKey,
      };
    }
    entries.set(key, entry);
    return entry;
  }

  function ensureMediaEntry(
    key: string,
    rendererId: string,
    sourceKey: string,
    mediaTexture: PixiTexture,
    crop: TopLeftCrop,
    detectionId: string | number | undefined,
  ) {
    let entry = entries.get(key);
    if (!entry) {
      const poolKey = resolvePoolKey(rendererId, sourceKey);
      const pool = pools.get(poolKey);
      entry = pool?.pop();
      if (pool?.length === 0) pools.delete(poolKey);
    }

    if (!entry) {
      const texture = new options.Texture({
        dynamic: true,
        frame: new options.Rectangle(crop.x, crop.y, crop.width, crop.height),
        source: mediaTexture.source,
      });
      const display = new options.Sprite({ texture });
      display.anchor.set(0.5);
      container?.addChild(display);
      entry = {
        active: false,
        baseX: 0,
        baseY: 0,
        detectionId,
        display,
        ownedTexture: texture,
        rendererId,
        sourceKey,
      };
    } else {
      entry.detectionId = detectionId;
    }

    updateMediaTexture(entry.ownedTexture!, mediaTexture, crop);
    entries.set(key, entry);
    return entry;
  }

  function destroyRendererDisplays(rendererId: string) {
    for (const [key, entry] of entries) {
      if (entry.rendererId !== rendererId) continue;
      destroyEntry(entry);
      entries.delete(key);
    }
    for (const [key, pool] of pools) {
      const retained = pool.filter((entry) => {
        if (entry.rendererId !== rendererId) return true;
        destroyEntry(entry);
        return false;
      });
      if (retained.length > 0) pools.set(key, retained);
      else pools.delete(key);
    }
  }

  function destroyAllDisplays() {
    for (const entry of entries.values()) destroyEntry(entry);
    for (const pool of pools.values()) {
      for (const entry of pool) destroyEntry(entry);
    }
    entries.clear();
    pools.clear();
  }
}

function destroyEntry(entry: RegionSpriteEntry) {
  entry.display.removeFromParent?.();
  // GifSprite sources are shared and released through Assets.unload().
  entry.display.destroy();
  // Media subtextures share the renderer-owned media source. Destroy only the
  // lightweight crop texture; the scene destroys the shared source.
  entry.ownedTexture?.destroy(false);
}

function pauseAnimatedDisplay(display: RegionDisplay) {
  if ("stop" in display && typeof display.stop === "function") display.stop();
}

function resumeAnimatedDisplay(display: RegionDisplay) {
  if ("play" in display && typeof display.play === "function") display.play();
}

function matchesTarget(
  renderer: RegionAnnotationRenderer,
  detection: Detection,
  context: AnnotationStyleContext,
) {
  const { target } = renderer;
  return (
    matchesValue(target.id, detection.id) &&
    matchesValue(target.className, detection.className) &&
    matchesValue(target.sourceId, detection.sourceId) &&
    (target.resolve?.(detection, context) ?? true)
  );
}

function matchesValue<T extends string | number>(
  configured: T | readonly T[] | undefined,
  actual: T | undefined,
) {
  if (configured === undefined) return true;
  if (actual === undefined) return false;
  return Array.isArray(configured)
    ? configured.includes(actual)
    : configured === actual;
}

function resolveRegion(
  region: RegionRendererRegion,
  detection: Detection,
): Rect | undefined {
  if (region.kind === "bounds") return detection.rect;

  const fallbackSize = detection.rect
    ? Math.max(1, detection.rect.width * 0.4)
    : undefined;
  if (region.anchor === "head") {
    const facePoints = detection.keypoints?.points
      .slice(0, 5)
      .filter(
        (_, index) => (detection.keypoints?.visibility?.[index] ?? 2) > 0,
      );
    if (facePoints && facePoints.length > 0) {
      const xs = facePoints.map(({ x }) => x);
      const ys = facePoints.map(({ y }) => y);
      const width = Math.max(
        fallbackSize ?? 1,
        (Math.max(...xs) - Math.min(...xs)) * 2,
      );
      return {
        height: width,
        width,
        x: xs.reduce((sum, x) => sum + x, 0) / xs.length,
        y: ys.reduce((sum, y) => sum + y, 0) / ys.length,
      };
    }
    if (!detection.rect || fallbackSize === undefined) return undefined;
    return {
      height: fallbackSize,
      width: fallbackSize,
      x: detection.rect.x,
      y: detection.rect.y - detection.rect.height / 2,
    };
  }

  const point = detection.keypoints?.points[region.anchor];
  const visibility = detection.keypoints?.visibility?.[region.anchor] ?? 2;
  if (!point || visibility <= 0 || fallbackSize === undefined) return undefined;
  return { height: fallbackSize, width: fallbackSize, x: point.x, y: point.y };
}

function positionSprite(
  sprite: RegionDisplay,
  renderer: RegionAnnotationRenderer,
  region: Rect,
  source: { readonly height: number; readonly width: number },
) {
  const scale = finiteOr(renderer.transform?.scale, 1);
  const opacity = Math.min(
    1,
    Math.max(0, finiteOr(renderer.transform?.opacity, 1)),
  );
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
  const containScale = Math.min(
    region.width / sourceWidth,
    region.height / sourceHeight,
  );
  const offset = renderer.transform?.offset;

  sprite.alpha = opacity;
  sprite.width = sourceWidth * containScale * scale;
  sprite.height = sourceHeight * containScale * scale;
  sprite.scale.x =
    Math.abs(sprite.scale.x) * (renderer.transform?.flip?.horizontal ? -1 : 1);
  sprite.scale.y =
    Math.abs(sprite.scale.y) * (renderer.transform?.flip?.vertical ? -1 : 1);
  const position = {
    x: region.x + finiteOr(offset?.x, 0) * region.width,
    y: region.y + finiteOr(offset?.y, 0) * region.height,
  };
  sprite.position.set(position.x, position.y);
  sprite.rotation = finiteOr(renderer.transform?.rotation, 0);
  return position;
}

function resolveMediaCrop(
  region: Rect,
  mediaTexture: PixiTexture,
): TopLeftCrop | undefined {
  const sourceWidth = mediaTexture.source.width;
  const sourceHeight = mediaTexture.source.height;
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return undefined;
  }

  const left = clamp(region.x - region.width / 2, 0, sourceWidth);
  const top = clamp(region.y - region.height / 2, 0, sourceHeight);
  const right = clamp(region.x + region.width / 2, 0, sourceWidth);
  const bottom = clamp(region.y + region.height / 2, 0, sourceHeight);
  const width = right - left;
  const height = bottom - top;

  return width > 0 && height > 0
    ? { height, width, x: left, y: top }
    : undefined;
}

function updateMediaTexture(
  texture: PixiTexture,
  mediaTexture: PixiTexture,
  crop: TopLeftCrop,
) {
  let changed = false;
  if (texture.source !== mediaTexture.source) {
    texture.source = mediaTexture.source;
    changed = true;
  }
  if (
    texture.frame.x !== crop.x ||
    texture.frame.y !== crop.y ||
    texture.frame.width !== crop.width ||
    texture.frame.height !== crop.height
  ) {
    texture.frame.x = crop.x;
    texture.frame.y = crop.y;
    texture.frame.width = crop.width;
    texture.frame.height = crop.height;
    changed = true;
  }
  if (changed) texture.update();
}

function isGifSource(asset: RegionAsset): asset is PixiGifSource {
  return (
    "totalFrames" in asset && "frames" in asset && Array.isArray(asset.frames)
  );
}

function resolvePoolKey(rendererId: string, src: string) {
  return JSON.stringify([rendererId, src]);
}

function resolveSourceKey(renderer: RegionAnnotationRenderer) {
  return renderer.source.kind === RegionRendererSourceKind.Asset
    ? `asset:${renderer.source.asset.src}`
    : RegionRendererSourceKind.Media;
}

function resolveSpriteKey(
  rendererId: string,
  detection: Detection,
  detectionIndex: number,
) {
  return JSON.stringify([rendererId, detection.id ?? null, detectionIndex]);
}

function finiteOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function acquireAsset(
  loader: RegionAssetLoader,
  src: string,
): RegionAssetLease {
  let cache = sharedAssets.get(loader as object);
  if (!cache) {
    cache = new Map();
    sharedAssets.set(loader as object, cache);
  }
  let entry = cache.get(src);
  if (!entry) {
    entry = { asset: loader.load<RegionAsset>(src), references: 0 };
    cache.set(src, entry);
  }
  entry.references += 1;
  let released = false;

  return {
    release() {
      if (released) return;
      released = true;
      entry!.references -= 1;
      if (entry!.references > 0) return;
      cache!.delete(src);
      void entry!.asset.then(
        () => loader.unload(src),
        () => undefined,
      );
    },
    asset: entry.asset,
  };
}
