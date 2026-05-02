# Agent Guidance

This is the shared source of truth for agent instructions in `supervision-js`.
Root-level agent files should stay short and point here so Codex, Claude, and
other tools do not drift into separate copies of the same guidance.

## Read First

Before making project-direction or architecture changes, read:

- [`problem-framing.md`](problem-framing.md)
- [`architecture-principles.md`](architecture-principles.md)
- [`renderer-first-roadmap.md`](renderer-first-roadmap.md)

Those docs define the current product intent: prove the browser rendering
foundation before designing a broad annotation framework.

## Project Direction

- Keep the core library vanilla browser TypeScript/JavaScript.
- Do not make React part of the core renderer. React belongs in `demo/` or
  future wrapper packages.
- Keep media and overlays visually composed inside the renderer-owned scene.
- Treat PixiJS as the first 2D backend proof, not as the public architecture.
- Avoid final public APIs, primitive hierarchies, or annotation schemas until
  renderer milestones create real constraints.

## Repo Shape

- `src/` is the package source.
- `demo/` is a React + Vite consumer demo.
- The demo should consume `supervision-js` through the package boundary, not by
  importing source files directly.
- Rollup builds package JavaScript.
- TypeScript emits declarations and performs typechecking.
- Vite runs and builds the demo.

## Commands

Run from the repository root:

- `npm install`
- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run demo:build`

For iterative demo work, use separate terminals:

- `npm run dev:lib`
- `npm run demo:dev`

## Dependency Freshness

This repo intentionally keeps packages fresh. The repo-local `.npmrc` overrides
the user's global npm release-age safety window with `min-release-age=0`.

When changing dependencies, refresh `package-lock.json` with normal `npm`
commands from the repo root and verify with `npm outdated`.
