import type {
  BufferedDetectionTimeline,
  Detection,
  DetectionFrame,
  DetectionHeatmap,
  HeatmapAnnotationRenderer,
} from "supervision-js-core";
import { getBufferedDetectionTimelineFrameSnapshot } from "supervision-js-core";
import type {
  CanvasSource as PixiCanvasSource,
  Container as PixiContainer,
  ImageSource as PixiImageSource,
  Sprite as PixiSprite,
  Texture as PixiTexture,
} from "pixi.js";
import {
  createHeatmapFramePreparer,
  type HeatmapFramePreparer,
  type PreparedHeatmapImage,
} from "#render-preparation/heatmap-frame-preparer";
import type { RenderPreparationOptions } from "#types/render-preparation";
import { colorizeHeatmap } from "./heatmap-color";

const ASYNC_HEATMAP_PIXELS = 65_536;
const MAX_VISIBLE_HEATMAP_PIXELS = 16_777_216;
const MAX_CACHED_HEATMAP_BYTES = 128 * 1024 * 1024;

interface CachedHeatmap {
  readonly texture: PixiTexture;
  readonly image: PreparedHeatmapImage;
  readonly bytes: number;
}

export function createPixiHeatmapLayer(options: {
  readonly CanvasSource: new (options: {
    resource: HTMLCanvasElement;
    width: number;
    height: number;
  }) => PixiCanvasSource;
  readonly ImageSource?: new (options: {
    dynamic: boolean;
    resource: ImageBitmap;
    width: number;
    height: number;
  }) => PixiImageSource;
  readonly Container: new () => PixiContainer;
  readonly Sprite: new (options: { texture: PixiTexture }) => PixiSprite;
  readonly Texture: new (options: {
    source: PixiCanvasSource | PixiImageSource;
  }) => PixiTexture;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly isVisible: (detection: Detection) => boolean;
  readonly onPreparedWindowChange?: () => void;
  readonly prepareTexture?: (texture: PixiTexture) => Promise<void>;
  readonly preparer?: HeatmapFramePreparer;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly renderers: readonly HeatmapAnnotationRenderer[];
}) {
  const container = new options.Container();
  let renderers = options.renderers;
  let lastFrame: DetectionFrame | undefined;
  let dirty = true;
  let warnedInvalidHeatmap = false;
  let warnedFrameBudget = false;
  let generation = 0;
  let nextIdentity = 0;
  let cachedBytes = 0;
  let destroyed = false;
  let activeJob:
    | {
        key: string;
        map: DetectionHeatmap;
        renderer: HeatmapAnnotationRenderer;
        generation: number;
      }
    | undefined;
  let preparer = options.preparer;
  const identities = new WeakMap<object, number>();
  const cache = new Map<string, CachedHeatmap>();
  const pending = new Map<string, NonNullable<typeof activeJob>>();
  const failed = new Set<string>();
  const activeKeys = new Set<string>();
  const wantedKeys = new Set<string>();
  const positionedSprites: {
    readonly sprite: PixiSprite;
    readonly detectionId: string | number | undefined;
    readonly x: number;
    readonly y: number;
    readonly temporaryTexture: boolean;
  }[] = [];

  const clear = () => {
    for (const { sprite, temporaryTexture } of positionedSprites) {
      const texture = sprite.texture;
      sprite.removeFromParent();
      sprite.destroy();
      if (temporaryTexture) texture.destroy(true);
    }
    positionedSprites.length = 0;
    activeKeys.clear();
  };

  const clearCache = () => {
    clear();
    for (const entry of cache.values()) {
      entry.texture.destroy(true);
      entry.image.close();
    }
    cache.clear();
    pending.clear();
    failed.clear();
    wantedKeys.clear();
    cachedBytes = 0;
    generation += 1;
  };

  const keyFor = (
    map: DetectionHeatmap,
    renderer: HeatmapAnnotationRenderer,
  ) => {
    const identity = (value: object) => {
      let id = identities.get(value);
      if (id === undefined) {
        id = ++nextIdentity;
        identities.set(value, id);
      }
      return id;
    };
    return `${identity(map)}:${identity(renderer)}`;
  };

  const touch = (key: string) => {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  };

  const evict = () => {
    for (const [key, entry] of cache) {
      if (cachedBytes <= MAX_CACHED_HEATMAP_BYTES) break;
      if (activeKeys.has(key)) continue;
      cache.delete(key);
      cachedBytes -= entry.bytes;
      entry.texture.destroy(true);
      entry.image.close();
    }
  };

  const makeCanvasTexture = (
    map: DetectionHeatmap,
    rgba: Uint8ClampedArray,
  ) => {
    const canvas = document.createElement("canvas");
    canvas.width = map.width;
    canvas.height = map.height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const pixels = context.createImageData(map.width, map.height);
    pixels.data.set(rgba);
    context.putImageData(pixels, 0, 0);
    return new options.Texture({
      source: new options.CanvasSource({
        resource: canvas,
        width: map.width,
        height: map.height,
      }),
    });
  };

  const makePreparedTexture = (
    map: DetectionHeatmap,
    image: PreparedHeatmapImage,
  ) => {
    if (
      typeof ImageBitmap !== "undefined" &&
      image.resource instanceof ImageBitmap &&
      options.ImageSource
    ) {
      return new options.Texture({
        source: new options.ImageSource({
          dynamic: false,
          resource: image.resource,
          width: map.width,
          height: map.height,
        }),
      });
    }
    const imageData = image.resource as ImageData;
    const texture = makeCanvasTexture(map, imageData.data);
    if (!texture) throw new Error("Unable to create heatmap texture.");
    return texture;
  };

  const visibleMaps = (frame: DetectionFrame) => {
    const orderedDetections = frame.detections
      .map((detection, index) => ({ detection, index }))
      .sort(
        (left, right) =>
          (left.detection.zIndex ?? left.index) -
            (right.detection.zIndex ?? right.index) || left.index - right.index,
      );
    const result: {
      detection: Detection;
      map: DetectionHeatmap;
      renderer: HeatmapAnnotationRenderer;
    }[] = [];
    let pixels = 0;
    for (const { detection } of orderedDetections) {
      const map = detection.heatmap;
      if (!map || !options.isVisible(detection)) continue;
      for (const renderer of renderers) {
        if (pixels + map.width * map.height > MAX_VISIBLE_HEATMAP_PIXELS) {
          if (!warnedFrameBudget) {
            console.warn(
              "Skipping heatmaps beyond the 16M-pixel frame budget.",
            );
            warnedFrameBudget = true;
          }
          continue;
        }
        pixels += map.width * map.height;
        result.push({ detection, map, renderer });
      }
    }
    return result;
  };

  const shouldPrepareAsync = (
    map: DetectionHeatmap,
    visiblePixelCount: number,
  ) =>
    map.width * map.height >= ASYNC_HEATMAP_PIXELS ||
    visiblePixelCount >= ASYNC_HEATMAP_PIXELS;

  const pump = () => {
    if (destroyed || activeJob || pending.size === 0) return;
    const job = pending.values().next().value;
    if (!job) return;
    pending.delete(job.key);
    activeJob = job;
    preparer ??= createHeatmapFramePreparer(options.renderPreparation);
    void preparer
      .prepare(job.map, job.renderer)
      .then(async (image) => {
        if (
          destroyed ||
          job.generation !== generation ||
          !wantedKeys.has(job.key)
        ) {
          image.close();
          return;
        }
        let texture: PixiTexture | undefined;
        try {
          texture = makePreparedTexture(job.map, image);
          await options.prepareTexture?.(texture);
        } catch (error) {
          texture?.destroy(true);
          image.close();
          failed.add(job.key);
          if (!warnedInvalidHeatmap) {
            console.warn("Skipping an invalid detection heatmap.", error);
            warnedInvalidHeatmap = true;
          }
          options.onPreparedWindowChange?.();
          return;
        }
        if (
          destroyed ||
          job.generation !== generation ||
          !wantedKeys.has(job.key)
        ) {
          texture.destroy(true);
          image.close();
          return;
        }
        cache.set(job.key, {
          texture,
          image,
          bytes: job.map.width * job.map.height * 4,
        });
        cachedBytes += job.map.width * job.map.height * 4;
        evict();
        dirty = true;
        options.onPreparedWindowChange?.();
      })
      .catch((error: unknown) => {
        if (destroyed || job.generation !== generation) return;
        failed.add(job.key);
        if (!warnedInvalidHeatmap) {
          console.warn("Skipping an invalid detection heatmap.", error);
          warnedInvalidHeatmap = true;
        }
        options.onPreparedWindowChange?.();
      })
      .finally(() => {
        if (activeJob === job) activeJob = undefined;
        pump();
      });
  };

  const enqueue = (
    map: DetectionHeatmap,
    renderer: HeatmapAnnotationRenderer,
  ) => {
    const key = keyFor(map, renderer);
    if (
      cache.has(key) ||
      failed.has(key) ||
      pending.has(key) ||
      activeJob?.key === key
    )
      return;
    pending.set(key, { key, map, renderer, generation });
    pump();
  };

  return {
    createContainer: () => container,
    setRenderers(next: readonly HeatmapAnnotationRenderer[]) {
      if (
        next.length === renderers.length &&
        next.every((renderer, index) => renderer === renderers[index])
      ) {
        return;
      }
      renderers = next;
      clearCache();
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    isArtifactPrepared(mediaTime: number) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      if (!frame || renderers.length === 0) return true;
      const maps = visibleMaps(frame);
      const visiblePixelCount = maps.reduce(
        (total, { map }) => total + map.width * map.height,
        0,
      );
      return maps.every(({ map, renderer }) => {
        if (!shouldPrepareAsync(map, visiblePixelCount)) return true;
        const key = keyFor(map, renderer);
        return cache.has(key) || failed.has(key);
      });
    },
    prepareFrame(mediaTime: number) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      if (!frame || renderers.length === 0) return;
      const maps = visibleMaps(frame);
      const visiblePixelCount = maps.reduce(
        (total, { map }) => total + map.width * map.height,
        0,
      );
      for (const { map, renderer } of maps) {
        if (shouldPrepareAsync(map, visiblePixelCount)) {
          wantedKeys.add(keyFor(map, renderer));
          enqueue(map, renderer);
        }
      }
    },
    translateDetection(id: string | number, dx: number, dy: number) {
      let translated = false;
      for (const entry of positionedSprites) {
        if (entry.detectionId !== id) continue;
        entry.sprite.x = entry.x + dx;
        entry.sprite.y = entry.y + dy;
        translated = true;
      }
      return translated;
    },
    drawFrame(mediaTime: number) {
      const frame = options.detectionTimeline.selectFrame(mediaTime);
      if (!dirty && frame === lastFrame) return;
      clear();
      pending.clear();
      wantedKeys.clear();
      if (!frame || renderers.length === 0) {
        lastFrame = frame;
        dirty = false;
        return;
      }

      const maps = visibleMaps(frame);
      const visiblePixelCount = maps.reduce(
        (total, { map }) => total + map.width * map.height,
        0,
      );
      for (const { detection, map, renderer } of maps) {
        const key = keyFor(map, renderer);
        if (shouldPrepareAsync(map, visiblePixelCount)) wantedKeys.add(key);
        let texture = touch(key)?.texture;
        let temporaryTexture = false;
        if (!texture && !failed.has(key)) {
          if (shouldPrepareAsync(map, visiblePixelCount)) {
            enqueue(map, renderer);
            continue;
          }
          try {
            texture = makeCanvasTexture(map, colorizeHeatmap(map, renderer));
            temporaryTexture = true;
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            failed.add(key);
            if (!warnedInvalidHeatmap) {
              console.warn("Skipping an invalid detection heatmap.", error);
              warnedInvalidHeatmap = true;
            }
            continue;
          }
        }
        if (!texture) continue;
        const sprite = new options.Sprite({ texture });
        sprite.x = map.bounds.x - map.bounds.width / 2;
        sprite.y = map.bounds.y - map.bounds.height / 2;
        sprite.width = map.bounds.width;
        sprite.height = map.bounds.height;
        container.addChild(sprite);
        if (!temporaryTexture) activeKeys.add(key);
        positionedSprites.push({
          sprite,
          detectionId: detection.id,
          x: sprite.x,
          y: sprite.y,
          temporaryTexture,
        });
      }
      evict();
      lastFrame = frame;
      dirty = false;

      const frames = getBufferedDetectionTimelineFrameSnapshot(
        options.detectionTimeline,
      );
      const frameIndex = frames.indexOf(frame);
      const nextFrame = frames[frameIndex + 1];
      if (frameIndex >= 0 && nextFrame) {
        const nextMaps = visibleMaps(nextFrame);
        const nextPixelCount = nextMaps.reduce(
          (total, { map }) => total + map.width * map.height,
          0,
        );
        for (const { map, renderer } of nextMaps) {
          if (shouldPrepareAsync(map, nextPixelCount)) {
            wantedKeys.add(keyFor(map, renderer));
            enqueue(map, renderer);
          }
        }
      }
    },
    destroy() {
      destroyed = true;
      clearCache();
      preparer?.destroy();
      container.destroy();
    },
  };
}
