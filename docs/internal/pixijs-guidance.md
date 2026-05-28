# PixiJS Guidance

PixiJS renderer changes should use the installed PixiJS skills and official
PixiJS guidance before changing draw paths, scene ownership, caching, particles,
or lifecycle behavior.

The public PixiJS skills live at
[`pixijs/pixijs-skills`](https://github.com/pixijs/pixijs-skills). In this repo,
agents should load the relevant installed PixiJS skill first, then keep these
project constraints in mind:

- use PixiJS v8 shape-then-fill/stroke `Graphics` APIs;
- keep `cacheAsTexture` for rare static layers and disable caches before
  destroying cached containers;
- keep `ParticleContainer` as a benchmark or proof comparison unless a future
  measured design explicitly promotes it;
- keep media and overlays inside one Pixi-owned visible scene.
