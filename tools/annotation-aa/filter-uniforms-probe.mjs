import * as Pixi from "pixi.js";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";

/** Alternates a pooled MaskFilter while two renderer-owned GPU copies stay live. */
export async function probeFilterUniformIsolation(
  requested,
  { bindings = true } = {},
) {
  const scopes = [],
    cases = [],
    errors = [],
    warnings = [];
  const priorWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    priorWarn(...args);
  };
  try {
    for (let index = 0; index < 2; index++) {
      const backend = await createBenchBackend(requested);
      if (backend.description.rendererName !== requested)
        throw Error("uniform probe backend silently fell back");
      backend.app.renderer.resize(32, 32, 1);
      backend.app.renderer.gpu?.device?.addEventListener(
        "uncapturederror",
        (event) => errors.push(String(event.error)),
      );
      const release = bindings
        ? installPixiFilterBindings(Pixi, backend.app.renderer)
        : () => undefined;
      const releaseBatch = installPixiBatchTextureBindings(
        Pixi,
        backend.app.renderer,
      );
      const pixels = new Uint8Array(4 * 4 * 4);
      for (let y = 1; y <= 2; y++) {
        for (let x = 1; x <= 2; x++)
          pixels.fill(255, (y * 4 + x) * 4, (y * 4 + x + 1) * 4);
      }
      const texture = new Pixi.Texture({
        source: new Pixi.BufferImageSource({
          resource: pixels,
          width: 4,
          height: 4,
          format: "rgba8unorm",
          scaleMode: "nearest",
          autoGenerateMipmaps: false,
        }),
      });
      const sprite = new Pixi.Sprite(Pixi.Texture.WHITE);
      sprite.width = sprite.height = 32;
      const mask = new Pixi.Sprite(texture);
      mask.width = mask.height = 32;
      sprite.setMask({
        mask: new Pixi.AlphaMask({ mask }),
        channel: "alpha",
        inverse: index === 0,
      });
      const stage = new Pixi.Container();
      stage.addChild(sprite, mask);
      const target = Pixi.RenderTexture.create({
        width: 32,
        height: 32,
        resolution: 1,
      });
      scopes.push({
        backend,
        release,
        releaseBatch,
        texture,
        textures: [texture],
        mask,
        sprite,
        stage,
        target,
      });
      await capture(index, index === 0, `renderer${index + 1}/initial`);
    }
    await capture(1, true, "renderer2/inverse-with-renderer1-live");
    await capture(0, false, "renderer1/normal-with-renderer2-live");
    await capture(1, false, "renderer2/normal-with-renderer1-live");
    for (let index = 0; index < 2; index++) {
      const opaquePixels = new Uint8Array(8 * 8 * 4);
      for (let pixel = 0; pixel < 64; pixel++) {
        opaquePixels[pixel * 4 + 1] = 255;
        opaquePixels[pixel * 4 + 3] = 255;
      }
      const texture = new Pixi.Texture({
        source: new Pixi.BufferImageSource({
          resource: opaquePixels,
          width: 8,
          height: 8,
          format: "rgba8unorm",
          scaleMode: "nearest",
          autoGenerateMipmaps: false,
        }),
        frame: new Pixi.Rectangle(
          0,
          0,
          index === 0 ? 4 : 8,
          index === 0 ? 4 : 8,
        ),
      });
      scopes[index].textures.push(texture);
      scopes[index].mask.texture = texture;
      scopes[index].mask.width = scopes[index].mask.height = 32;
      await capture(
        index,
        false,
        `renderer${index + 1}/opaque-crop-${texture.frame.width}`,
        {
          center: 255,
          corner: 255,
          right: 255,
          cornerPoint: 8,
        },
      );
    }
    scopes[1].sprite.setMask({ channel: "red" });
    await capture(1, false, "renderer2/red-channel-with-renderer1-live", {
      center: 0,
      corner: 0,
      right: 0,
      cornerPoint: 8,
    });
    scopes[1].sprite.setMask({ channel: "alpha" });
    await capture(1, false, "renderer2/alpha-channel-with-renderer1-live", {
      center: 255,
      corner: 255,
      right: 255,
      cornerPoint: 8,
    });
    dispose(scopes[0]);
    scopes[1].mask.texture = scopes[1].texture;
    scopes[1].mask.width = scopes[1].mask.height = 32;
    await capture(1, true, "renderer2/inverse-after-renderer1-disposal");
  } catch (error) {
    errors.push(String(error));
  } finally {
    for (const scope of scopes) dispose(scope);
    console.warn = priorWarn;
  }
  return {
    backend: requested,
    bindings,
    cases,
    errors,
    warnings,
    definition:
      "Two actual Pixi renderers alternate normal/inverse masks, small/full texture crops and alpha/red channels while both remain alive. Center/corner/right alpha is checked exactly, then the surviving renderer switches again after its peer is disposed. No private buffer flags or manual uniform uploads.",
  };

  async function capture(index, inverse, phase, expected) {
    const scope = scopes[index];
    scope.sprite.setMask({ inverse });
    scope.backend.app.renderer.render({
      container: scope.stage,
      target: scope.target,
      clear: true,
    });
    await scope.backend.finish(scope.target);
    const pixels = await scope.backend.readPixels(scope.target);
    const center = pixels[(16 * 32 + 16) * 4 + 3];
    const cornerPoint = expected?.cornerPoint ?? 1;
    const corner = pixels[(cornerPoint * 32 + cornerPoint) * 4 + 3];
    const right = pixels[(16 * 32 + 24) * 4 + 3];
    const expectedCenter = expected?.center ?? (inverse ? 0 : 255),
      expectedCorner = expected?.corner ?? (inverse ? 255 : 0);
    cases.push({
      phase,
      inverse,
      centerAlpha: center,
      cornerAlpha: corner,
      rightAlpha: right,
      expectedCenter,
      expectedCorner,
      expectedRight: expected?.right,
      textureSourceSize: scope.mask.texture.source.width,
      textureFrameSize: scope.mask.texture.frame.width,
    });
    if (
      center !== expectedCenter ||
      corner !== expectedCorner ||
      (expected?.right !== undefined && right !== expected.right)
    )
      errors.push(
        `${phase}: center/corner/right were ${center}/${corner}/${right}, expected ${expectedCenter}/${expectedCorner}/${expected?.right ?? "unchecked"}`,
      );
  }

  function dispose(scope) {
    if (!scope || scope.disposed) return;
    scope.disposed = true;
    scope.releaseBatch();
    scope.release();
    scope.stage.destroy({ children: true });
    for (const texture of scope.textures) texture.destroy(true);
    scope.target.destroy(true);
    scope.backend.destroy();
  }
}
