import type { Batch, BindResource, Renderer, TextureSource } from "pixi.js";

type PixiBatchResources = Pick<
  typeof import("pixi.js"),
  "BindGroup" | "Texture"
>;

/**
 * Discarding video and heatmap textures leaves Pixi's global batch cache bound
 * to them. This scene owns groups that retire with a texture or the scene.
 */
export function installPixiBatchTextureBindings(
  pixi: PixiBatchResources,
  renderer: Renderer,
): () => void {
  const pipe = renderer.renderPipes?.batch;
  if (renderer.name !== "webgpu" || !pipe) return () => undefined;

  const groups = new Map<string, OwnedBatchBindGroup>();
  const empty = pixi.Texture.EMPTY.source;
  const originalExecute = pipe.execute;

  class OwnedBatchBindGroup extends pixi.BindGroup {
    constructor(
      resources: Record<string, BindResource>,
      private readonly key: string,
      private readonly sources: Set<TextureSource>,
    ) {
      super(resources);
      for (const source of sources) {
        source.on("styleChange", this.destroy, this);
      }
    }

    protected override onResourceChange(resource: BindResource) {
      if (!this.resources) return;
      if (resource.destroyed) {
        this.destroy();
        return;
      }
      super.onResourceChange(resource);
    }

    override destroy() {
      if (!this.resources) return;
      if (groups.get(this.key) === this) groups.delete(this.key);
      for (const source of this.sources) {
        source.off("styleChange", this.destroy, this);
      }
      this.sources.clear();
      super.destroy();
    }
  }

  const getBindGroup = (batch: Batch) => {
    const textures = batch.textures;
    const sources = [];
    for (let index = 0; index < textures.count; index += 1) {
      const source = textures.textures[index];
      sources.push(source.destroyed || source.style.destroyed ? empty : source);
    }
    const maxTextures = renderer.limits.maxBatchableTextures;
    const key = `${maxTextures}:${sources.map((source) => source.uid).join("|")}`;
    const cached = groups.get(key);
    if (cached) return cached;

    const resources: Record<string, BindResource> = {};
    const boundSources = new Set<TextureSource>();
    for (let index = 0; index < maxTextures; index += 1) {
      const source = sources[index] ?? empty;
      resources[index * 2] = source;
      resources[index * 2 + 1] = source.style;
      boundSources.add(source);
    }
    const group = new OwnedBatchBindGroup(resources, key, boundSources);
    groups.set(key, group);
    return group;
  };

  const execute = (batch: Batch) => {
    if (!batch.bindGroup || !batch.bindGroup.resources) {
      batch.bindGroup = getBindGroup(batch);
    }
    originalExecute.call(pipe, batch);
  };
  pipe.execute = execute;

  return () => {
    if (pipe.execute === execute) pipe.execute = originalExecute;
    for (const group of groups.values()) group.destroy();
    groups.clear();
  };
}
