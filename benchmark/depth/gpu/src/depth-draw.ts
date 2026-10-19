import {
  BufferImageSource,
  Container,
  ImageSource,
  Mesh,
  MeshGeometry,
  RenderTexture,
  Shader,
  UniformGroup,
  type TextureSource,
} from "pixi.js";
import {
  resolveDepthColorMapping,
  type DepthAnnotationRenderer,
  type DepthMap,
  type DepthQuantity,
  type DepthRange,
} from "supervision-js-core";
import {
  createDepthTextureRing,
  type DepthBufferImageSourceConstructor,
  type DepthTextureRing,
} from "../../../../packages/web/src/renderers/depth-textures";
import {
  createPixiDepthShaderRenderer,
  resolveDepthShaderUniforms,
  type PixiDepthShaderRenderer,
} from "../../../../packages/web/src/renderers/pixi-depth-shader";
import type { BenchBackend } from "./pixi-backend";

/**
 * The library's own depth drawing, assembled the way its depth layer does it:
 * the texture ring uploads maps, and one depth shader mesh draws them into a
 * render texture the size of the media. Nothing here is a copy of library
 * code; the benchmark only chooses the maps, the colour table and the range.
 */
export interface DepthDraw {
  readonly target: RenderTexture;
  readonly ring: DepthTextureRing;
  /** Binds `map` (uploading it if it is not resident) and draws it. */
  draw(
    map: DepthMap,
    lut: TextureSource,
    options: {
      readonly range: DepthRange;
      readonly noDepthColor?: number;
      readonly quantity?: DepthQuantity;
    },
  ): void;
  destroy(): void;
}

export function createDepthDraw(
  backend: BenchBackend,
  media: { readonly width: number; readonly height: number },
  ringSize = 3,
): DepthDraw {
  const acceptsUnalignedRows = backend.description.rendererName === "webgpu";
  const ring = createDepthTextureRing({
    BufferImageSource:
      BufferImageSource as unknown as DepthBufferImageSourceConstructor,
    acceptsUnalignedTextureRows: () => acceptsUnalignedRows,
    maxTextureSize: () => backend.description.maxTextureSize,
    size: ringSize,
  });
  const shader: PixiDepthShaderRenderer = createPixiDepthShaderRenderer({
    ImageSource: ImageSource as never,
    Mesh: Mesh as never,
    MeshGeometry: MeshGeometry as never,
    Shader: Shader as never,
    UniformGroup: UniformGroup as never,
    mediaHeight: media.height,
    mediaWidth: media.width,
  });
  const container = new Container();
  const target = RenderTexture.create({
    antialias: false,
    height: media.height,
    resolution: 1,
    width: media.width,
  });

  container.addChild(shader.mesh);

  return {
    ring,
    target,

    draw(map, lut, options) {
      const slot = ring.acquire(map);
      const descriptor: DepthAnnotationRenderer = {
        id: "benchmark",
        kind: "depth",
        noDepthColor: options.noDepthColor ?? null,
        quantity: options.quantity,
        range: options.range,
        sampling: "auto",
      };
      const mapping = resolveDepthColorMapping(map, descriptor);

      shader.render(
        slot.source,
        lut,
        resolveDepthShaderUniforms(
          map,
          mapping,
          descriptor,
          media,
          slot.displaySize,
        ),
      );
      backend.app.renderer.render({
        clear: true,
        clearColor: [0, 0, 0, 0],
        container,
        target,
      });
    },

    destroy() {
      container.removeChildren();
      shader.destroy();
      ring.destroy();
      target.destroy(true);
      container.destroy();
    },
  };
}

/** A 256x1 colour table from a function of the entry index. */
export function createLut(
  entry: (index: number) => readonly [number, number, number],
): BufferImageSource {
  const bytes = new Uint8Array(256 * 4);

  for (let index = 0; index < 256; index += 1) {
    const [red, green, blue] = entry(index);

    bytes.set([red, green, blue, 255], index * 4);
  }

  return new BufferImageSource({
    alphaMode: "no-premultiply-alpha",
    autoGenerateMipmaps: false,
    format: "rgba8unorm",
    height: 1,
    resource: bytes,
    scaleMode: "linear",
    width: 256,
  });
}
