import type {
  AnnotationStyleContext,
  BufferedDetectionTimeline,
  Detection,
  DetectionFrame,
  Rect,
  RegionAnnotationRenderer,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";
import type {
  GifSource as PixiGifSource,
  GifSprite as PixiGifSprite,
} from "pixi.js/gif";

type RegionAsset = PixiTexture | PixiGifSource;
type RegionDisplay = PixiSprite | PixiGifSprite;

interface RegionAssetLoader {
  load<T = RegionAsset>(src: string): Promise<T>;
  unload(src: string): Promise<void>;
}

interface RegionSpriteEntry {
  readonly display: RegionDisplay;
  readonly rendererId: string;
  readonly src: string;
  active: boolean;
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
  destroy(): void;
}

/** Browser implementation for asset-backed region renderer descriptors. */
export function createPixiRegionLayer(options: {
  readonly Assets: RegionAssetLoader;
  readonly Container: new () => PixiContainer;
  readonly GifSprite: new (options: {
    readonly autoPlay?: boolean;
    readonly loop?: boolean;
    readonly source: PixiGifSource;
  }) => PixiGifSprite;
  readonly Sprite: new (options: { texture: PixiTexture }) => PixiSprite;
  readonly detectionTimeline: BufferedDetectionTimeline;
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

  syncAssets();

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
          const asset = assets.get(renderer.id);
          if (!asset?.asset) continue;

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

            const region = resolveRegion(renderer, detection);
            if (!region) continue;

            const key = resolveSpriteKey(
              renderer.id,
              detection,
              detectionIndex,
            );
            const entry = ensureEntry(key, renderer.id, asset.src, asset.asset);
            positionSprite(entry.display, renderer, region, asset.asset);
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
        const poolKey = resolvePoolKey(entry.rendererId, entry.src);
        const pool = pools.get(poolKey) ?? [];
        pool.push(entry);
        pools.set(poolKey, pool);
      }

      return { activeDetectionIndexes: [...activeDetectionIndexes] };
    },

    setRenderers(nextRenderers) {
      renderers = [...nextRenderers];
      syncAssets();
      this.drawFrame(currentMediaTime, currentViewportScale);
    },

    destroy() {
      destroyed = true;
      destroyAllDisplays();
      for (const asset of assets.values()) asset.lease.release();
      assets.clear();
      container = undefined;
      currentFrame = undefined;
    },
  };

  function syncAssets() {
    const desired = new Map(
      renderers.map((renderer) => [renderer.id, renderer.source.asset.src]),
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

  function ensureEntry(
    key: string,
    rendererId: string,
    src: string,
    asset: RegionAsset,
  ) {
    let entry = entries.get(key);
    if (entry) return entry;

    const poolKey = resolvePoolKey(rendererId, src);
    const pool = pools.get(poolKey);
    entry = pool?.pop();
    if (pool?.length === 0) pools.delete(poolKey);
    if (entry) {
      resumeAnimatedDisplay(entry.display);
    } else {
      const display = isGifSource(asset)
        ? new options.GifSprite({ autoPlay: true, loop: true, source: asset })
        : new options.Sprite({ texture: asset });
      display.anchor.set(0.5);
      container?.addChild(display);
      entry = { active: false, display, rendererId, src };
    }
    entries.set(key, entry);
    return entry;
  }

  function destroyRendererDisplays(rendererId: string) {
    for (const [key, entry] of entries) {
      if (entry.rendererId !== rendererId) continue;
      destroyDisplay(entry.display);
      entries.delete(key);
    }
    for (const [key, pool] of pools) {
      const retained = pool.filter((entry) => {
        if (entry.rendererId !== rendererId) return true;
        destroyDisplay(entry.display);
        return false;
      });
      if (retained.length > 0) pools.set(key, retained);
      else pools.delete(key);
    }
  }

  function destroyAllDisplays() {
    for (const entry of entries.values()) destroyDisplay(entry.display);
    for (const pool of pools.values()) {
      for (const entry of pool) destroyDisplay(entry.display);
    }
    entries.clear();
    pools.clear();
  }
}

function destroyDisplay(display: RegionDisplay) {
  display.removeFromParent?.();
  // GifSprite sources are shared and released through Assets.unload().
  display.destroy();
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
  renderer: RegionAnnotationRenderer,
  detection: Detection,
): Rect | undefined {
  if (renderer.region.kind === "bounds") return detection.rect;

  const fallbackSize = detection.rect
    ? Math.max(1, detection.rect.width * 0.4)
    : undefined;
  if (renderer.region.anchor === "head") {
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

  const point = detection.keypoints?.points[renderer.region.anchor];
  const visibility =
    detection.keypoints?.visibility?.[renderer.region.anchor] ?? 2;
  if (!point || visibility <= 0 || fallbackSize === undefined) return undefined;
  return { height: fallbackSize, width: fallbackSize, x: point.x, y: point.y };
}

function positionSprite(
  sprite: RegionDisplay,
  renderer: RegionAnnotationRenderer,
  region: Rect,
  asset: RegionAsset,
) {
  const scale = finiteOr(renderer.transform?.scale, 1);
  const opacity = Math.min(
    1,
    Math.max(0, finiteOr(renderer.transform?.opacity, 1)),
  );
  const sourceWidth = Math.max(1, asset.width);
  const sourceHeight = Math.max(1, asset.height);
  const containScale = Math.min(
    region.width / sourceWidth,
    region.height / sourceHeight,
  );
  const offset = renderer.transform?.offset;

  sprite.alpha = opacity;
  sprite.width = sourceWidth * containScale * scale;
  sprite.height = sourceHeight * containScale * scale;
  sprite.position.set(
    region.x + finiteOr(offset?.x, 0) * region.width,
    region.y + finiteOr(offset?.y, 0) * region.height,
  );
  sprite.rotation = finiteOr(renderer.transform?.rotation, 0);
}

function isGifSource(asset: RegionAsset): asset is PixiGifSource {
  return (
    "totalFrames" in asset && "frames" in asset && Array.isArray(asset.frames)
  );
}

function resolvePoolKey(rendererId: string, src: string) {
  return JSON.stringify([rendererId, src]);
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
