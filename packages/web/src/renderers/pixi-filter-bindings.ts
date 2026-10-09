import type {
  BindGroup,
  AlphaMaskPipe,
  BindOptions,
  FilterSystem,
  MaskFilter,
  Renderer,
  UniformGroup,
} from "pixi.js";

type PixiFilterResources = Pick<
  typeof import("pixi.js"),
  "MaskFilter" | "UniformGroup"
>;

const maskUniformOrigins = new WeakMap<UniformGroup, UniformGroup>();

/** Keeps nested mask cutouts aligned and filter disposal scene-owned. */
export function installPixiFilterBindings(
  pixi: PixiFilterResources,
  renderer: Renderer,
): () => void {
  const releaseMaskTarget = installMaskTargetBindings(renderer);
  if (renderer.name !== "webgpu") return releaseMaskTarget;

  const system = renderer.filter;
  const originalApplyFilter = system.applyFilter;
  let globalGroup: BindGroup | undefined;
  const maskGroups = new Map<
    MaskFilter,
    { original: UniformGroup; owned: UniformGroup }
  >();

  const applyFilter: FilterSystem["applyFilter"] = (
    filter,
    input,
    output,
    clear,
  ) => {
    if (filter.enabled && filter instanceof pixi.MaskFilter) {
      const source = filter.resources.filterUniforms as UniformGroup;
      let entry = maskGroups.get(filter);
      if (!entry) {
        const original = maskUniformOrigins.get(source) ?? source;
        const owned = new pixi.UniformGroup(original.uniformStructures, {
          isStatic: original.isStatic,
          ubo: original.ubo,
        });
        maskUniformOrigins.set(owned, original);
        entry = { original, owned };
        maskGroups.set(filter, entry);
      }
      // Pixi pools MaskFilters across renderers. Their uniform buffers need
      // one GPU upload owner, even when a second scene borrows the same filter.
      if (source !== entry.owned) {
        Object.assign(entry.owned.uniforms, source.uniforms);
        filter.resources.filterUniforms = entry.owned;
        if (entry.owned.isStatic) entry.owned.update();
      }
    }
    originalApplyFilter.call(system, filter, input, output, clear);
    // Pixi replaces group 0 with its renderer-owned group when applying an
    // enabled filter. Disabled filters use a separate passthrough shader.
    if (filter.enabled) globalGroup = filter.groups[0];
  };
  system.applyFilter = applyFilter;

  return () => {
    releaseMaskTarget();
    if (system.applyFilter === applyFilter) {
      system.applyFilter = originalApplyFilter;
    }
    globalGroup?.destroy();
    globalGroup = undefined;
    for (const [filter, { original, owned }] of maskGroups) {
      if (filter.resources?.filterUniforms === owned) {
        Object.assign(original.uniforms, owned.uniforms);
        filter.resources.filterUniforms = original;
      }
      const buffer = owned.buffer;
      owned.buffer = undefined;
      buffer?.destroy();
    }
    maskGroups.clear();
  };
}

function installMaskTargetBindings(renderer: Renderer): () => void {
  const pipe = renderer.renderPipes?.alphaMask;
  if (!pipe) return () => undefined;
  const targets = renderer.renderTarget;
  const originalExecute = pipe.execute;
  const captures: BindOptions[] = [];
  const execute: AlphaMaskPipe["execute"] = (instruction) => {
    if (!instruction.mask.renderMaskToTexture) {
      originalExecute.call(pipe, instruction);
      return;
    }
    if (instruction.action === "pushMaskBegin") {
      captures.push(targets.getBindState());
    }
    if (instruction.action !== "pushMaskEnd") {
      originalExecute.call(pipe, instruction);
      return;
    }
    const binding = captures.pop();
    const originalPop = targets.pop;
    // Filters bind their captures without pushing them onto the target stack.
    // Returning from an alpha-mask capture must restore that bound surface.
    targets.pop = () => {
      const target = originalPop.call(targets);
      return binding ? targets.bind(binding) : target;
    };
    try {
      originalExecute.call(pipe, instruction);
    } finally {
      targets.pop = originalPop;
    }
  };
  pipe.execute = execute;
  return () => {
    if (pipe.execute === execute) pipe.execute = originalExecute;
    captures.length = 0;
  };
}
