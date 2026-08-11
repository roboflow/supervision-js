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

interface RegionAssetLoader {
  load<T = PixiTexture>(src: string): Promise<T>;
  unload(src: string): Promise<void>;
}

interface RegionSpriteEntry {
  readonly display: PixiSprite;
  active: boolean;
}

interface RegionAssetLease {
  readonly texture: Promise<PixiTexture>;
  release(): void;
}

interface SharedAssetEntry {
  readonly texture: Promise<PixiTexture>;
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
      texture?: PixiTexture;
    }
  >();
  const entries = new Map<string, RegionSpriteEntry>();
  const pool: RegionSpriteEntry[] = [];

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
          if (!asset?.texture) continue;

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
            const entry = ensureEntry(key, asset.texture);
            positionSprite(entry.display, renderer, region, asset.texture);
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
        entries.delete(key);
        pool.push(entry);
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
      for (const asset of assets.values()) asset.lease.release();
      assets.clear();
      for (const entry of [...entries.values(), ...pool]) {
        entry.display.removeFromParent?.();
        entry.display.destroy();
      }
      entries.clear();
      pool.length = 0;
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
      asset.lease.release();
      assets.delete(id);
    }

    for (const [id, src] of desired) {
      if (assets.has(id)) continue;
      const lease = acquireAsset(options.Assets, src);
      const asset: {
        readonly src: string;
        readonly lease: RegionAssetLease;
        texture?: PixiTexture;
      } = { lease, src };
      assets.set(id, asset);
      void lease.texture.then(
        (texture) => {
          if (destroyed || assets.get(id) !== asset) return;
          asset.texture = texture;
          options.onInvalidate?.();
        },
        (error) => {
          // A failed asset is omitted. Replacing the descriptor retries it.
          options.onAssetError?.({ error, rendererId: id, src });
        },
      );
    }
  }

  function ensureEntry(key: string, texture: PixiTexture) {
    let entry = entries.get(key);
    if (entry) return entry;

    entry = pool.pop();
    if (entry) {
      entry.display.texture = texture;
    } else {
      const display = new options.Sprite({ texture });
      display.anchor.set(0.5);
      container?.addChild(display);
      entry = { active: false, display };
    }
    entries.set(key, entry);
    return entry;
  }
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
  sprite: PixiSprite,
  renderer: RegionAnnotationRenderer,
  region: Rect,
  texture: PixiTexture,
) {
  const scale = finiteOr(renderer.transform?.scale, 1);
  const opacity = Math.min(
    1,
    Math.max(0, finiteOr(renderer.transform?.opacity, 1)),
  );
  const sourceWidth = Math.max(1, texture.width);
  const sourceHeight = Math.max(1, texture.height);
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
    entry = { references: 0, texture: loader.load<PixiTexture>(src) };
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
      void entry!.texture.then(
        () => loader.unload(src),
        () => undefined,
      );
    },
    texture: entry.texture,
  };
}
