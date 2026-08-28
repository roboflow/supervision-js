# Tarball Packaging

The portable tarball is the artifact published to npm. It is not a public
consumer installation channel: consumers install the stable package with
`npm install supervision`. This document exists for maintainers who validate
or change the packaging path.

Only `supervision` needs an assembled tarball. `supervision-js-web-video-engine`
depends on registry packages alone, so plain `npm pack` on its workspace already
produces a portable archive; [The Video Engine Archive](#the-video-engine-archive)
covers it.

## Build The Tarball

```sh
npm run package:tarball
```

That command builds the internal tracker engines into `supervision-js-core`,
builds the published `supervision` package, and then writes a single archive to
the ignored `artifacts/` directory:

```text
artifacts/supervision-<version>.tgz
```

`artifacts/` is cleared of previous `supervision-*.tgz` archives on every run,
so exactly one artifact exists at a time. Pass `--skip-build` to repack existing
`dist/` output, or `--out-dir=<path>` to write elsewhere:

```sh
node tools/pack-web-tarball.mjs --skip-build --out-dir=/tmp/supervision
```

The archive is deliberately installed by path only inside the smoke test. That
test proves the archive is portable before npm receives it; it is not consumer
documentation.

## How The Private Core Is Made Portable

`packages/web` depends on `supervision-js-core` through `file:../core`. That
spec resolves inside the workspace but points at a directory an external
consumer does not have, and the built browser JavaScript keeps its bare
`supervision-js-core` imports because Rollup marks the core external.

Rather than collapsing that boundary in source, `tools/pack-web-tarball.mjs`
resolves it at pack time:

1. `npm pack` both workspaces so npm decides which files each package ships.
2. Extract the web archive into a staging directory.
3. Extract the core archive into `node_modules/supervision-js-core` inside that
   staging directory.
4. Remove core's monorepo-only `supervision-js-trackers` build dependency. Its
   JavaScript is already bundled into the core entrypoint.
5. Rewrite the staged manifest: pin `supervision-js-core` to its version
   instead of `file:../core`, and list it in `bundleDependencies`.
6. `npm pack` the staging directory into the output archive.

The source tree, package boundary checks, and Rollup externals are unchanged.
`pixi.js` and `mediabunny` stay ordinary dependencies and are installed from the
registry by the consumer.

`supervision-js-web-video-engine` is external to the build as well, and the packer leaves
it alone. The published JavaScript keeps its dynamic
`import("supervision-js-web-video-engine")`, which runs only when a caller opens a
video-engine media source, so importing either entrypoint never reaches for it.
An application that does open such a source installs the engine itself, which is
why `supervision` declares it as an optional peer dependency.

## The Video Engine Archive

```sh
npm run package:engine:tarball
```

That command builds `packages/video-engine` and writes a single archive:

```text
artifacts/engine/supervision-js-web-video-engine-<version>.tgz
```

The archive lives under `artifacts/engine/` rather than beside the browser
archive so that neither the packer's cleanup nor the release workflow's
`artifacts/supervision-*.tgz` glob can match the wrong file. Both would, since
the engine's name starts with the browser package's name.

The engine's manifest ships `dist` only, exactly as `supervision` does, and it
declares `mediabunny` as an ordinary registry dependency. Nothing is staged or
rewritten, so the archive npm receives is the one `npm pack` produces.
`npm run package:engine:publish:dry-run` recreates it and validates the exact
argument npm will be given, without publishing.

## Verify The Artifact

```sh
npm run package:tarball
npm run package:tarball:smoke
```

The smoke suite inspects the archive and then builds a throwaway npm project in
the OS temp directory — outside this repository — to check that:

- both JavaScript entrypoints, their declarations and source maps are present;
- the standalone render-preparation worker is present, has no sibling chunk
  imports, and is exported as `supervision/render-preparation-worker`;
- the main browser entry embeds the worker source instead of referencing a
  runtime-relative worker URL;
- `supervision-js-core` is bundled while `pixi.js` and `mediabunny` are not;
- tracker engines are embedded in core and do not appear as an install-time
  package or lockfile dependency;
- a clean archive installation produces a lockfile with no `file:` path;
- `supervision` and `supervision/editing` import under Node;
- a minimal Vite production build that imports `createMediaSession` succeeds.

`package:tarball:smoke` installs public dependencies from the registry and runs
a Vite build, so it is deliberately kept out of `npm run verify`. Run it when
changing packaging, dependencies, or package entrypoints. Point it at another
archive with `SUPERVISION_TARBALL=<path>`.

## npm Publishing

Do not run `npm publish` from `packages/web`: its workspace manifest
intentionally points at the private core package through `file:../core`. The
assembled archive is the only form of that package which may be published.

See [npm-release.md](npm-release.md) for release ownership, trusted-publisher
configuration, stable and preview tags, and the protected manual workflow. Use
`npm run package:publish:dry-run` to recreate the artifact and validate the
exact local archive argument that npm will receive, without publishing it.
