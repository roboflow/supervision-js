import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferImageSource } from "pixi.js";
import {
  BaseMaskStyle,
  createBufferedDetectionTimeline,
  encodeBinaryMask,
  type DetectionFrame,
} from "supervision-js-core";
import { createPixiMaskLayer } from "./pixi-mask-layer";
import * as compositor from "#render-preparation/mask-frame-compositor";
import {
  RenderPreparationMode,
  type RenderPreparationDiagnostics,
} from "#types/render-preparation";

const MiB = 1024 * 1024;
const budget = 17 * MiB;

class ImageSource {
  constructor(readonly options: { resource: unknown }) {}
  destroy() {}
}
class Texture {
  static EMPTY = new Texture({ source: new ImageSource({ resource: null }) });
  readonly source: ImageSource | BufferImageSource;
  destroyed = false;
  constructor(options: { source: ImageSource | BufferImageSource }) {
    this.source = options.source;
  }
  destroy() {
    this.destroyed = true;
    this.source.destroy();
  }
}
class Sprite {
  texture = Texture.EMPTY;
  width = 0;
  height = 0;
  alpha = 1;
  visible = false;
  destroy() {}
}

function installCanvasBoundary() {
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ putImageData() {} }),
    }),
  });
}

async function createHarness(
  width: number,
  coverage: boolean,
  unaligned = false,
  fallbackRasterWidth?: number,
) {
  installCanvasBoundary();
  const height = 1024;
  const mask = encodeBinaryMask(
    new Uint8Array(width * height).fill(1),
    width,
    height,
  );
  const frames: DetectionFrame[] = Array.from(
    { length: 3 },
    (_, frameIndex) => ({
      frameIndex,
      mediaTime: frameIndex,
      detections: [{ mask }],
    }),
  );
  const timeline = createBufferedDetectionTimeline({
    bufferAheadSeconds: 4,
    bufferBehindSeconds: 4,
    frameRate: 1,
    source: { loadFrames: async () => frames },
  });
  await timeline.prepare(0);
  let diagnostics: RenderPreparationDiagnostics | undefined;
  const layer = createPixiMaskLayer({
    BufferImageSource,
    ImageSource: ImageSource as never,
    Sprite: Sprite as never,
    Texture: Texture as never,
    acceptsUnalignedTextureRows: () => unaligned,
    detectionTimeline: timeline,
    maskStyle: new BaseMaskStyle(),
    renderPreparation: {
      mode: RenderPreparationMode.MainThread,
      maskFrame: {
        ...(fallbackRasterWidth
          ? {
              display: {
                boxWidth: fallbackRasterWidth,
                boxHeight: fallbackRasterWidth,
                devicePixelRatio: 1,
              },
            }
          : {}),
        maxCacheBytes: budget,
        maxCacheFrameCount: 100,
        prefetchFrameCount: 1,
        scanIntervalSeconds: 0,
      },
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    },
    ...(coverage
      ? {
          resolveInstructions: ({ frame }: { frame: DetectionFrame }) => [
            {
              alpha: 0,
              color: 0,
              detectionIndex: 0,
              mask: frame.detections[0]!.mask!,
              visible: false,
              regionCoverageMask: frame.detections[0]!.mask!,
            },
          ],
        }
      : {}),
  });
  const sprite = layer.createSprite({ width, height }) as unknown as Sprite;
  async function visit(time: number) {
    layer.prepareFrame(time);
    await vi.advanceTimersByTimeAsync(10);
    layer.drawFrame(time);
    expect(layer.getDrawnState().drawnFrameTime).toBe(time);
  }
  return {
    layer,
    sprite,
    visit,
    readDiagnostics: () => diagnostics!.artifacts[0]!,
    destroy() {
      layer.destroy();
      timeline.destroy();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepared masks reserve retained renderer backing", () => {
  it("evicts native region crops carried by invisible one-pixel frames", async () => {
    vi.useFakeTimers();
    const harness = await createHarness(1024, true);
    try {
      await harness.visit(0);
      const first = harness.layer.getActiveRegionMaskCoverage(0)!;
      expect(first.frame.entries[0]!.data.byteLength).toBe(MiB);
      const texture = first.getTexture(
        first.frame.entries[0]!,
      ) as unknown as Texture;
      expect((texture.source as ImageSource).options.resource).toMatchObject({
        width: 1024,
        height: 1024,
      });
      await harness.visit(1);
      await harness.visit(2);
      expect(harness.readDiagnostics().preparedCount).toBe(1);
      expect(harness.readDiagnostics().preparedBytes).toBeGreaterThan(9 * MiB);
      expect(harness.readDiagnostics().preparedBytes).toBeLessThanOrEqual(
        budget,
      );
      expect(texture.destroyed).toBe(true);
      const revision = harness.layer.getArtifactRevision(2);
      await harness.visit(2);
      expect(harness.layer.getArtifactRevision(2)).toBe(revision);
    } finally {
      harness.destroy();
    }
  });

  it("reserves RGBA fallback backing and its independently capped halo plane before upload", async () => {
    vi.useFakeTimers();
    // Decline the primary id artifact; the fallback's real plane cook still runs.
    vi.spyOn(compositor, "createIdMaskRasterFrame").mockReturnValue(undefined);
    const harness = await createHarness(1024, false, false, 256);
    try {
      await harness.visit(0);
      expect(harness.layer.getDrawnState().idMaskStatus).toBe("absent");
      expect(
        (harness.sprite.texture.source as ImageSource).options.resource,
      ).toMatchObject({ width: 1024, height: 1024 });
      await harness.visit(1);
      await harness.visit(2);
      expect(harness.readDiagnostics().preparedCount).toBe(1);
      expect(harness.readDiagnostics().preparedBytes).toBe(
        8 * MiB + 9 * 256 * 256,
      );
      const revision = harness.layer.getArtifactRevision(2);
      await harness.visit(2);
      expect(harness.layer.getArtifactRevision(2)).toBe(revision);
    } finally {
      harness.destroy();
    }
  });

  it.each([
    { width: 1025, unaligned: false, retained: 1, channels: 4 },
    { width: 1024, unaligned: false, retained: 3, channels: 1 },
    { width: 1025, unaligned: true, retained: 3, channels: 1 },
  ])(
    "reserves the uploaded $channels-channel resource at width $width with unaligned support $unaligned",
    async ({ width, unaligned, retained, channels }) => {
      vi.useFakeTimers();
      const harness = await createHarness(width, false, unaligned);
      try {
        await harness.visit(0);
        const first = harness.layer.getActiveIdMaskFrameTexture(0)!;
        const source = first.texture.source as BufferImageSource;
        expect(source.resource.byteLength).toBe(width * 1024 * channels);
        expect(source.format).toBe(channels === 4 ? "rgba8unorm" : "r8unorm");
        await harness.visit(1);
        await harness.visit(2);
        expect(harness.readDiagnostics().preparedCount).toBe(retained);
        expect(harness.readDiagnostics().preparedBytes).toBeLessThanOrEqual(
          budget,
        );
        const revision = harness.layer.getArtifactRevision(2);
        await harness.visit(2);
        expect(harness.layer.getArtifactRevision(2)).toBe(revision);
      } finally {
        harness.destroy();
      }
    },
  );
});
