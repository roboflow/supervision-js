# Agent Guidance

This is the shared source of truth for agent instructions in `supervision-js`.
Root-level agent files should stay short and point here so Codex, Claude, and
other tools do not drift into separate copies of the same guidance.

## Read First

Before making project-direction or architecture changes, read:

- [`problem-framing.md`](problem-framing.md)
- [`architecture-principles.md`](architecture-principles.md)
- [`renderer-first-roadmap.md`](renderer-first-roadmap.md)
- [`annotator-use-case-roadmap.md`](annotator-use-case-roadmap.md) when adding
  visualization recipes, fixtures, or annotator facades
- [`pixijs-guidance.md`](pixijs-guidance.md)
- [`library-contract.md`](library-contract.md)
- [`video-engine-presentation.md`](video-engine-presentation.md) before touching
  video presentation, the atomic present, the prepared annotation window, or
  anything that imports the video engine
- [`react-native-architecture.md`](react-native-architecture.md)
- [`react-native-live-rendering.md`](react-native-live-rendering.md)
- [`tarball-packaging.md`](tarball-packaging.md)
- [`npm-release.md`](npm-release.md) when changing package publication or
  release automation
- [`../public/guides/public-api.md`](../public/guides/public-api.md)

Those docs define the current product intent: maintain a focused, session-first
browser API without promising a one-to-one Python annotation framework. Python
Supervision may inform use-case facades when they preserve the renderer-first
and composable architecture.

## Public Docs Home

[`../public/index.md`](../public/index.md) is the source of the public docs
homepage. Update it in the same change when the public package name or install
path, the session-first API, supported browser capabilities, public/private
package boundary, or documentation entrypoints materially change.

Keep it consumer-facing and current: explain the architecture enough to orient
an integrator, but do not promote Pixi, Mediabunny, workers, prepared artifacts,
or the private React Native experiment into public contracts. Do not edit
generated `docs/site/` output; rebuild the docs with `npm run demo:build` and
run `npm run docs:check` after changing the homepage.

Public rendering guidance lives under
[`../public/annotation-renderers.md`](../public/annotation-renderers.md). Treat
an **annotation renderer descriptor** as the consumer-facing unit: semantic
detections provide the data, presentation styles control appearance, and the
session composes the enabled renderers. When a public renderer is added or
materially changed, update its focused page and the `Annotation Renderers`
navigation children in the same change. Add the reusable docs playground only
when a committed frozen fixture contains the renderer's real semantic input;
each such playground should show that fixture, focused controls, and a minimal
live `session.setPresentation({ renderers: [...] })` snippet whose values stay
synchronized with those controls. Do not fabricate docs-only detections to
simulate a missing fixture. Record any unsupported playground in
`annotator-use-case-roadmap.md` with the next fixture or primitive required.
Keep Pixi display objects, backend resources, drawing callbacks, and docs-only
fixture augmentation out of the published package API; public
`AnnotationRenderer` descriptors remain semantic configuration.

The documentation toolbar displays the browser package version from
`docs/public/typedoc-icons.js`. Update that value with
`packages/web/package.json` in every browser package release; `npm run
docs:check` rejects a mismatch. Public docs must show the version that is
actually published as `latest`; the package manifest is canonical, while the
toolbar value is a checked presentation mirror.

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
- `packages/trackers/` is an internal, platform-neutral engine workspace. It
  owns SORT, ByteTrack, C-BIoU, OC-SORT, association, Kalman state, and their
  lightweight observation/assignment contracts. It must not import core
  detections, masks, workers, rendering code, or browser APIs. Core bundles it;
  it is not an independently published package.
- `packages/core/` is the DOM-free, platform-neutral core package. It owns
  detections, rectangles, masks, detection timelines, memory-backed sources,
  retention policies, source composition, picking contracts, style contracts,
  session lifecycle contracts, media-rendering state/readout contracts, base
  style classes, and pure utilities.
- `packages/web/` is the browser package published as `supervision`. It owns
  `createMediaSession()`, `createMediaRenderer()`, Pixi rendering, Mediabunny
  media adapters, browser normalization/preparation, playback, IndexedDB cold
  detection storage, workers, and browser render-preparation artifacts.
- `packages/react-native/` is a private experimental package named
  `supervision-js-react-native`. It depends on `supervision-js-core`, must
  not depend on the browser package `supervision`, and must not import Pixi,
  Mediabunny, DOM APIs, or browser storage.
- `packages/web/src/index.ts` is the browser package entrypoint. It re-exports
  the supported core API plus web-only APIs so consumers still import from
  `supervision`.
- `packages/core/src/index.ts` is the core package entrypoint. Keep it free of
  DOM/WebWorker APIs and browser/vendor dependencies.
- Core consumes tracking engines through `supervision-js-trackers`. Detection
  geometry projection, mask/keypoint bounds, mutation semantics, and public
  tracker facades remain in core; never reach into `packages/trackers/src`.
- Keep renderer orchestration provider-agnostic. The public/default renderer
  factory may wire Mediabunny and Pixi defaults, but the renderer core should
  depend on small media-source and scene contracts rather than vendor modules.
- An engine-backed media source announces every presented frame and the scene
  composites it. It is opt-in: `createMediaSession()` reaches it only when a host
  passes `createVideoEngineMediaRendererSource()`, and the pull path still serves
  the `src` route, normalization output, and `MediaStream` inputs.
  `supervision/web-video-engine` and `supervision/web-video-engine/analysis` are
  the only entries that carry code, and ESLint enforces that. Read
  [`video-engine-presentation.md`](video-engine-presentation.md) before changing
  any of it.
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
- A fixture may declare a second encode of its media as `media.proxyFile` and
  the demo plays that instead of the source. Two things move every annotation if
  a proxy gets them wrong. Frame count and timestamps must match the source,
  because detections index presented source frames. And the manifest's
  `video.width` and `video.height` must keep naming the media the detections were
  computed against, never the proxy, because vector geometry is absolute media
  pixels and is projected from that declaration. Loading refuses a fixture whose
  manifest size disagrees with the media it plays.
- `benchmark/initial/` is the isolated Milestone 3 dense-shape benchmark.
  Benchmark renderer code belongs there, not in the package entrypoint or the
  normal demo.
- The demo should consume `supervision` through the package boundary, not by
  importing source files directly.
- `test/` holds reusable Vitest harness helpers that should not be emitted as
  package source.
- Rollup builds package JavaScript. The root build builds trackers into core,
  then builds React Native and web.
- Rollup emits a self-contained render-preparation worker, then embeds that
  source in `dist/index.js` for a bundler-agnostic Blob-worker default. The
  `supervision/render-preparation-worker` subpath exposes the same standalone
  script only as a CSP/deployment asset; its message protocol remains internal.
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
- `npm run eval:demo`
- `npm run build`
- `npm run demo:build`
- `npm run benchmark:initial:build`
- `npm run benchmark:media-upload:build`
- `npm run benchmark:masks`
- `npm run package:tarball`
- `npm run package:tarball:smoke`
- `npm run package:publish:dry-run`

`package:tarball` builds the core and browser packages and writes one portable
`artifacts/supervision-<version>.tgz` with the internal core bundled inside.
`package:tarball:smoke` installs that archive in a temporary consumer outside
the repository; it needs the registry and is not part of `npm run verify`. See
[`tarball-packaging.md`](tarball-packaging.md).

The manual npm workflow publishes that generated tarball after environment
approval; it never publishes `packages/web` directly. See
[`npm-release.md`](npm-release.md) before running or modifying it.

`eval:demo` measures the running demo over the Chrome DevTools Protocol:
painting while nothing moves, detection sync, transport latency, gesture stress,
per-defect regression guards, and a comparison against this machine's recorded
baseline. It is the check that catches defects a unit test under a mock cannot,
and it needs a real browser and a running dev server, so `npm run verify` does
not include it. Its own `.test.ts` files do run under `npm run test`. See
[`../../tools/demo-eval/README.md`](../../tools/demo-eval/README.md) for
prerequisites, scenarios and flags.

### The Demo Runs The Built Package

The demo imports `supervision` through the package boundary, and that package's
entry is its build output under `packages/web/dist`. Vitest resolves the same
specifier to `packages/web/src`. After editing library source, the tests
therefore see the change and the browser does not, which reads exactly like a
broken feature: green suites over a page running yesterday's code.

`npm run dev` is the loop that stays honest, because it keeps the package build
watchers running next to the demo server. `npm run demo:dev` builds once before
starting the server, and `npm run dev:demo` does not build at all, so under
either of those every library edit needs `npm run build` before the browser can
run it. The watchers rebuild JavaScript only; `npm run build` is also what
refreshes the `supervision` declarations the demo typechecks against, the video
engine's among them.

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

## Pull Request Descriptions

Use [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)
for this repository. Do not add generic `Deployment considerations`, `hosting`,
or `Infrastructure impact` sections: `supervision-js` is a library and static
documentation/demo workspace, and those application-deployment prompts are not
part of its pull request contract. Describe release, compatibility, migration,
or performance implications under `Notes For Reviewers` only when they are
actually relevant.

## Dependency Freshness

This repo intentionally keeps packages fresh. The repo-local `.npmrc` overrides
the user's global npm release-age safety window with `min-release-age=0`.

When changing dependencies, refresh `package-lock.json` with normal `npm`
commands from the repo root and verify with `npm outdated`.
