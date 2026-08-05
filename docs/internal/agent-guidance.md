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
- [`library-contract.md`](library-contract.md)
- [`react-native-architecture.md`](react-native-architecture.md)
- [`react-native-live-rendering.md`](react-native-live-rendering.md)
- [`tarball-packaging.md`](tarball-packaging.md)
- [`npm-release.md`](npm-release.md) when changing package publication or
  release automation
- [`../public/guides/public-api.md`](../public/guides/public-api.md)

Those docs define the current product intent: maintain a focused, session-first
browser API without promising a broad Python-parity annotation framework.

## Project Direction

- Keep the core library vanilla browser TypeScript/JavaScript.
- Do not make React part of the core renderer. React belongs in `demo/` or
  future wrapper packages.
- Keep media and overlays visually composed inside the renderer-owned scene.
- Treat PixiJS as the first 2D backend implementation, not as the public architecture.
- Keep the documented public API deliberate. Add primitives or schemas only when
  renderer constraints and real consumer use cases justify them.

## Repo Shape

- The root package is a private workspace orchestrator.
- `packages/core/` is the DOM-free, platform-neutral core package. It owns
  detections, rectangles, masks, detection timelines, memory-backed sources,
  retention policies, source composition, picking contracts, style contracts,
  session lifecycle contracts, media-rendering state/readout contracts, base
  style classes, and pure utilities.
- `packages/web/` is the browser package named `supervision-js`. It owns
  `createMediaSession()`, `createMediaRenderer()`, Pixi rendering, Mediabunny
  media adapters, browser normalization/preparation, playback, IndexedDB cold
  detection storage, workers, and browser render-preparation artifacts.
- `packages/react-native/` is a private experimental package named
  `supervision-js-react-native`. It depends on `supervision-js-core`, must not
  depend on `supervision-js`, and must not import Pixi, Mediabunny, DOM APIs, or
  browser storage.
- `packages/web/src/index.ts` is the browser package entrypoint. It re-exports
  the supported core API plus web-only APIs so consumers still import from
  `supervision-js`.
- `packages/core/src/index.ts` is the core package entrypoint. Keep it free of
  DOM/WebWorker APIs and browser/vendor dependencies.
- Keep renderer orchestration provider-agnostic. The public/default renderer
  factory may wire Mediabunny and Pixi defaults, but the renderer core should
  depend on small media-source and scene contracts rather than vendor modules.
- Treat [`docs/public/guides/public-api.md`](../public/guides/public-api.md) as
  the public boundary. Prefer `createMediaSession()` for normal consumers,
  advanced renderer/detection/media hooks for serious integrations, and keep
  Pixi/Mediabunny/worker/prepared-artifact details internal.
- Web package code should import core-owned concepts from `supervision-js-core`,
  not by reaching into `packages/core/src`.
- Use package-private TypeScript aliases only within each package for
  package-local cross-folder imports, such as `#media/...`, `#renderers/...`,
  or `#types/...` in `packages/web`, and `#detections/...`, `#styles/...`, or
  `#utils/...` in `packages/core`.
- Prefer `#types/...` for internal type modules; do not use `@types/...`, which
  reads like DefinitelyTyped package space. Same-folder imports may stay
  relative when that is clearer.
- `demo/` is a React + Vite consumer demo.
- `benchmark/initial/` is the isolated Milestone 3 dense-shape benchmark.
  Benchmark renderer code belongs there, not in the package entrypoint or the
  normal demo.
- The demo should consume `supervision-js` through the package boundary, not by
  importing source files directly.
- `test/` holds reusable Vitest harness helpers that should not be emitted as
  package source.
- Rollup builds package JavaScript. The root build runs core first, then web.
- Rollup emits the default render-preparation worker beside `dist/index.js`;
  keep worker entrypoints package-internal unless a public API explicitly needs
  them.
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
- `npm run boundary:check`
- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run demo:build`
- `npm run benchmark:initial:build`
- `npm run benchmark:media-upload:build`
- `npm run benchmark:masks`
- `npm run package:tarball`
- `npm run package:tarball:smoke`
- `npm run package:publish:dry-run`

`package:tarball` builds the core and browser packages and writes one portable
`artifacts/supervision-js-<version>.tgz` with the internal core bundled inside.
`package:tarball:smoke` installs that archive in a temporary consumer outside
the repository; it needs the registry and is not part of `npm run verify`. See
[`tarball-packaging.md`](tarball-packaging.md).

The manual npm workflow publishes that generated tarball after environment
approval; it never publishes `packages/web` directly. See
[`npm-release.md`](npm-release.md) before running or modifying it.

For focused iterative work, use separate terminals:

- `npm run dev:lib`
- `npm run demo:dev`
- `npm run benchmark:initial:dev`
- `npm run benchmark:media-upload:dev`

The demo dev server binds to `http://127.0.0.1:5173` by default.
The initial benchmark dev server binds to `http://127.0.0.1:5174` by default.
The media upload benchmark dev server binds to `http://127.0.0.1:5178` by
default.

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
