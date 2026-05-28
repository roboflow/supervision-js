# Agent Guidance

This is the shared source of truth for agent instructions in `supervision-js`.
Root-level agent files should stay short and point here so Codex, Claude, and
other tools do not drift into separate copies of the same guidance.

## Read First

Before making project-direction or architecture changes, read:

- [`problem-framing.md`](problem-framing.md)
- [`architecture-principles.md`](architecture-principles.md)
- [`renderer-first-roadmap.md`](renderer-first-roadmap.md)
- [`pixijs-guidance.md`](pixijs-guidance.md)

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
- `benchmark/initial/` is the isolated Milestone 3 dense-shape benchmark.
  Benchmark renderer code belongs there, not in the package entrypoint or the
  normal demo.
- The demo should consume `supervision-js` through the package boundary, not by
  importing source files directly.
- Rollup builds package JavaScript.
- TypeScript emits declarations and performs typechecking.
- Vitest tests the library source. Rollup is verified by the build step rather
  than used as a test runner.
- Vite runs and builds the demo.
- The React demo is a consumer harness, not the primary unit-test target.

## Commands

Run from the repository root:

- `npm install`
- `npm run dev`
- `npm run verify`
- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run demo:build`
- `npm run benchmark:initial:build`

For focused iterative work, use separate terminals:

- `npm run dev:lib`
- `npm run demo:dev`
- `npm run benchmark:initial:dev`

The demo dev server binds to `http://127.0.0.1:5173` by default.
The initial benchmark dev server binds to `http://127.0.0.1:5174` by default.

## Commit Checks

Husky and lint-staged run on pre-commit. The hook formats staged supported
files and applies ESLint fixes to staged JavaScript and TypeScript files.

Run `npm run verify` before handing off a larger change. It is the same command
used by GitHub Actions.

## Dependency Freshness

This repo intentionally keeps packages fresh. The repo-local `.npmrc` overrides
the user's global npm release-age safety window with `min-release-age=0`.

When changing dependencies, refresh `package-lock.json` with normal `npm`
commands from the repo root and verify with `npm outdated`.
