# Tarball Packaging

This repository is private, so websites cannot install `supervision-js` from a
registry or from a Git URL. The supported distribution for now is one portable
npm tarball.

## Build The Tarball

```sh
npm run package:tarball
```

That command builds `supervision-js-core` and `supervision-js`, then writes a
single archive to the ignored `artifacts/` directory:

```
artifacts/supervision-js-0.0.0.tgz
```

`artifacts/` is cleared of previous `supervision-js-*.tgz` archives on every
run, so exactly one artifact exists at a time. Pass `--skip-build` to repack
existing `dist/` output, or `--out-dir=<path>` to write elsewhere:

```sh
node tools/pack-web-tarball.mjs --skip-build --out-dir=/tmp/supervision-js
```

## Install In A Website

Copy the archive next to the consuming project and install it by path:

```sh
npm install ./supervision-js-0.0.0.tgz
```

Both supported entrypoints then resolve normally:

```ts
import { createMediaSession } from "supervision-js";
import { createMaskBrushEditor } from "supervision-js/editing";
```

The consumer needs an npm-compatible bundler such as Vite, webpack, Parcel, or
esbuild. There is no CDN, UMD, or `<script>` distribution.

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
4. Rewrite the staged manifest: pin `supervision-js-core` to its version instead
   of `file:../core`, and list it in `bundleDependencies`.
5. `npm pack` the staging directory into the output archive.

The source tree, the package boundary checks, and the Rollup externals are all
unchanged. `pixi.js` and `mediabunny` stay ordinary dependencies and are
installed from the registry by the consumer.

## Verify The Artifact

```sh
npm run package:tarball
npm run package:tarball:smoke
```

The smoke suite inspects the archive and then builds a throwaway npm project in
the OS temp directory — outside this repository — to check that:

- both entrypoints, their declarations, source maps, and the render-preparation
  worker plus the content-hashed chunks it imports are present;
- `supervision-js-core` is bundled while `pixi.js` and `mediabunny` are not;
- a clean `npm install <tarball>` produces a lockfile with no `file:` path;
- `supervision-js` and `supervision-js/editing` import under Node;
- a minimal Vite production build that imports `createMediaSession` succeeds.

`package:tarball:smoke` installs public dependencies from the registry and runs
a Vite build, so it is deliberately kept out of `npm run verify`. Run it when
changing packaging, dependencies, or package entrypoints. Point it at another
archive with `SUPERVISION_JS_TARBALL=<path>`.
