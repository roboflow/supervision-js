import type { Container, Texture } from "pixi.js";
import type {
  DetectionFrame,
  DetectionMask,
  MaskDrawInstruction,
} from "supervision-js-core";
import { IdMaskTextureFormat } from "#render-preparation/mask-frame-artifact";
import type { PreparedPackedMaskCoverage } from "#render-preparation/packed-mask-coverage";
import type { BufferImageSourceConstructor } from "./pixi-mask-layer";
import { detectionRenderOrder } from "./detection-render-order";
import { createPackedMaskPaint } from "./packed-mask-paint";
import {
  createPixiIdMaskShaderRenderer,
  type PixiIdMaskPaint,
} from "./pixi-id-mask-shader";

type ShaderOptions = Parameters<typeof createPixiIdMaskShaderRenderer>[0];
type Unit = {
  readonly renderer: ReturnType<typeof createPixiIdMaskShaderRenderer>;
  readonly texture: Texture;
  readonly mask: DetectionMask;
  paint?: PixiIdMaskPaint;
  frameKey: string;
};

/** Conservative reserve for known per-unit paint, CPU/GPU UBO, geometry and placeholder backing. */
export const PACKED_MASK_UNIT_BACKING_BYTES = 16 * 1024;

/** Only the active frame owns displays; prepared frames own and budget their coverage. */
export function createPixiOrderedMaskUnits(
  options: Omit<
    ShaderOptions,
    "mediaWidth" | "mediaHeight" | "packedCoverage"
  > & {
    readonly BufferImageSource: BufferImageSourceConstructor;
    readonly Texture: new (options: {
      dynamic: boolean;
      source: InstanceType<BufferImageSourceConstructor>;
    }) => Texture;
    readonly container: Container;
    readonly mediaWidth: number;
    readonly mediaHeight: number;
  },
) {
  const units = new Map<number, Unit>();
  options.container.sortableChildren = true;
  return { render, hide, clear, releaseFrame };

  function render(
    frameKey: string,
    frame: DetectionFrame,
    coverage: readonly PreparedPackedMaskCoverage[],
    resolveInstruction: (
      detectionIndex: number,
    ) => MaskDrawInstruction | undefined,
    viewportScale: number,
    opacity: number,
    pixelRatio: number,
  ) {
    const retained = new Set<number>();
    const order = detectionRenderOrder(frame);
    for (const entry of coverage) {
      const detection = frame.detections[entry.detectionIndex];
      if (!detection) continue;
      const key = entry.detectionIndex;
      const instruction = resolveInstruction(entry.detectionIndex);
      let unit = units.get(key);
      // A style can hide a mask without discarding its unchanged active coverage.
      if (!instruction?.mask) {
        if (unit) destroyUnit(key, unit);
        continue;
      }
      const mask = instruction.mask;
      if (unit && !sameMask(unit.mask, mask)) {
        destroyUnit(key, unit);
        unit = undefined;
      }
      if (!unit) {
        unit = createUnit(frameKey, entry, mask);
        units.set(key, unit);
      }
      retained.add(key);
      unit.frameKey = frameKey;
      // Equal semantic coverage across immutable frame revisions can reuse the GPU
      // upload. Rebind its CPU view so the old prepared frame is not retained.
      unit.texture.source.resource = entry.data;
      const mesh = unit.renderer.mesh;
      mesh.position.set(
        (entry.x * options.mediaWidth) / entry.sourceWidth,
        (entry.y * options.mediaHeight) / entry.sourceHeight,
      );
      mesh.scale.set(
        (entry.width * options.mediaWidth) / entry.sourceWidth,
        (entry.height * options.mediaHeight) / entry.sourceHeight,
      );
      mesh.zIndex =
        (order[entry.detectionIndex] ?? entry.detectionIndex) * 2 + 0.5;
      unit.paint = createPackedMaskPaint(
        entry,
        instruction,
        options.mediaWidth,
        viewportScale,
        opacity,
        unit.paint,
      );
      unit.renderer.render(unit.paint, unit.texture, pixelRatio);
    }
    for (const [key, unit] of units) {
      if (!retained.has(key)) destroyUnit(key, unit);
    }
  }

  function createUnit(
    frameKey: string,
    entry: PreparedPackedMaskCoverage,
    mask: DetectionMask,
  ): Unit {
    const source = new options.BufferImageSource({
      autoGenerateMipmaps: false,
      dynamic: false,
      format: IdMaskTextureFormat.R8,
      height: entry.height,
      resource: entry.data,
      scaleMode: "nearest",
      width: entry.textureWidth,
    });
    const texture = new options.Texture({ dynamic: false, source });
    const renderer = createPixiIdMaskShaderRenderer({
      ...options,
      mediaWidth: 1,
      mediaHeight: 1,
      packedCoverage: true,
    });
    renderer.mesh.eventMode = "none";
    options.container.addChild(renderer.mesh);
    return { renderer, texture, mask, frameKey };
  }

  function hide() {
    for (const unit of units.values()) unit.renderer.hide();
  }

  function releaseFrame(frameKey: string) {
    for (const [key, unit] of units) {
      if (unit.frameKey === frameKey) destroyUnit(key, unit);
    }
  }

  function clear() {
    for (const [key, unit] of units) destroyUnit(key, unit);
  }

  function destroyUnit(key: number, unit: Unit) {
    unit.renderer.hide();
    unit.renderer.clearTexture();
    unit.renderer.destroy();
    unit.texture.destroy(true);
    units.delete(key);
  }
}

function sameMask(left: DetectionMask, right: DetectionMask) {
  return (
    left === right ||
    (left.width === right.width &&
      left.height === right.height &&
      left.counts === right.counts)
  );
}
