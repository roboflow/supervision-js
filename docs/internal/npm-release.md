# npm Release Operations

This repository publishes two public packages: `supervision` and
`supervision-js-web-video-engine`. The root workspace, `supervision-js-trackers`,
`supervision-js-core`, and `supervision-js-react-native` remain private. The
tracker workspace is compiled into core rather than shipped as another
installable package.

`supervision` is published as the portable tarball assembled by
`tools/pack-web-tarball.mjs`; it embeds the private core package without
exposing the workspace-relative `file:../core` dependency.
`supervision-js-web-video-engine` depends only on registry packages, so `npm pack`
on its workspace already produces a portable archive. It is the optional peer
that `supervision` loads through a dynamic import, and the install command
`supervision` names when that import fails is `npm install
supervision-js-web-video-engine`.

## Release Boundary

Never publish from `packages/web` directly. A release publishes exactly one
generated file per package:

```text
artifacts/supervision-<version>.tgz
artifacts/engine/supervision-js-web-video-engine-<version>.tgz
```

The engine archive is written to its own directory so the browser archive's
glob cannot match it.

The manual GitHub Actions workflow at
`.github/workflows/publish-npm.yml` recreates and independently validates both
artifacts before publishing them. Stable `latest` releases run only from `main`;
an explicit prerelease may run from a `release/*` branch with the `next` tag.
Every publish is gated by the `npm-publish` GitHub environment.

`latest` is the default tag for a reviewed, general-availability release. A
stable publish updates the default version that `npm install supervision`
resolves.

Each package's manifest version is the source of truth for that package, and
the two move independently. `packages/web/package.json` carries the release
identity: the stable release workflow creates the matching GitHub Release and
`v<version>` tag from the `main` commit that npm published. That release page is
the canonical GitHub record; npm is the canonical installation source.

The engine publishes first, so `supervision` never reaches the registry naming
a peer that cannot be installed. A release that leaves
`packages/video-engine/package.json` untouched finds the engine version already
published and skips it.

## Publication Access

The package names are `supervision` and `supervision-js-web-video-engine`; the
repository remains `supervision-js`. Keep this ownership and security posture in
place:

1. At least two active Roboflow maintainers have npm package access and two-factor
   authentication.
2. npm **Trusted publisher** points exactly to GitHub Actions organization
   `roboflow`, repository `supervision-js`, workflow `publish-npm.yml`, and
   environment `npm-publish` for the **npm publish** action. Each npm package
   carries its own trusted publisher, so both packages need this entry.
3. GitHub's `npm-publish` environment requires release-owner approval.
4. The `npm-publish` environment holds a `RELEASE_GITHUB_TOKEN` environment
   secret scoped only to `supervision-js`, with **Contents: write** and
   **Workflows: write**. It is used only after verification to create the
   stable tag and GitHub Release; do not expose it to checkout, install, build,
   or npm-publish steps. Checkout must use `persist-credentials: false` so its
   short-lived `GITHUB_TOKEN` cannot override the dedicated token during the
   tag push.
5. No long-lived npm write token is stored in GitHub. Publishing uses OIDC.

If publishing access breaks, compare the trusted-publisher fields with the
workflow before changing credentials. Each npm package supports one trusted
publisher.

### Registering A New Package Name

npm will not attach a trusted publisher to a name that does not exist yet, so
the workflow cannot perform a package's very first publish. Before the first
release of a new public package, a maintainer registers the name from their own
machine and then configures its trusted publisher:

```sh
npm trust github supervision-js-web-video-engine \
  --file publish-npm.yml \
  --repository roboflow/supervision-js \
  --environment npm-publish
```

`npm trust list supervision-js-web-video-engine` reads back what was registered.

`npm trust` needs npm 11.10 or later. Without it, the fallback is one manual
authenticated publish of a placeholder version below the first real release,
followed by the same trusted-publisher configuration in the npm package
settings. Every later release of that package runs through the workflow over
OIDC.

## Choose The Version And Tag

Version each package with SemVer against its own published surface:

| Change                                                                                           | Example version from `0.1.7` | Tag      |
| ------------------------------------------------------------------------------------------------ | ---------------------------- | -------- |
| Backward-compatible fix, docs, dependency maintenance, internal refactor, or public API addition | `0.1.8`                      | `latest` |
| Breaking public API or behavior change before 1.0                                                | `0.2.0`                      | `latest` |

While the public packages remain in the experimental `0.1.x` line,
backward-compatible public API additions release as patches alongside fixes.
A new minor version communicates an intentional compatibility break or reset
before `1.0`. This is the repository's release policy for the prototype phase;
SemVer itself treats `0.y.z` as initial development. A package's first release
enters that line at `0.1.0`. Changes limited to private React Native
experiments do not by themselves change either published version.

`packages/web/package.json` declares `supervision-js-web-video-engine` as an
optional peer with a caret range. Bump that range whenever the engine's minor
version moves, because a `0.x` caret stops at the next minor and a stale range
tells consumers to install an engine the browser package cannot use.

## Release Procedure

1. Update `packages/web/package.json`, `packages/video-engine/package.json` if
   the engine changed, `package-lock.json`, and the checked docs toolbar version
   together. `npm run docs:check` verifies the toolbar mirror against the
   browser manifest.
2. Keep the public repository README and hosted docs aligned with the currently
   published stable release. Consumer installation guidance is always
   `npm install supervision`; do not document local archive paths for consumers.
3. Run the normal validation plus the clean-consumer artifact smoke test:

   ```sh
   npm run verify
   npm run package:tarball
   npm run package:tarball:smoke
   npm run package:publish:dry-run
   npm run package:engine:publish:dry-run
   ```

4. Merge the reviewed release-preparation pull request to `main`.
5. In GitHub Actions, run **Publish npm package** from `main` and select
   `latest` for a stable release. Approve the `npm-publish` environment
   deployment. The workflow verifies, packs, smoke-tests, publishes the
   generated archives through npm trusted publishing, waits briefly for the
   selected npm tag to propagate, creates the matching annotated Git tag, and
   creates the matching GitHub Release.
6. Verify npm metadata, provenance, tarball contents, and a clean installation
   in a separate consumer:

   ```sh
   npm view supervision dist-tags --json
   npm view supervision@<version> version
   npm pack supervision@<version>
   npm view supervision-js-web-video-engine dist-tags --json
   ```

7. Confirm that the GitHub Release `v<version>` points at the same `main`
   commit the workflow published. Then verify that public installation guidance,
   the toolbar version, and the documentation deployment match the stable
   release.

### Prerelease Procedure

Use a dedicated `release/*` branch when an integration needs to consume an
unmerged commit. Set `packages/web/package.json` to a unique SemVer prerelease
such as `0.2.0-next.0`, update the lockfile and docs toolbar mirror, then run
**Publish npm package** from that release branch with `next`. npm versions are
immutable: each later prerelease needs a new version such as
`0.2.0-next.1`; the `next` dist-tag moves to that newest version. A release
branch can never publish `latest` or create a stable GitHub Release.

## Recovery

If publishing fails before uploading the package, fix the failure in a pull
request and rerun the workflow from `main`. npm versions are immutable once
published: never try to overwrite one. Publish a new patch version instead.

If package publishing succeeds but GitHub Release creation fails, do not start
a new default dispatch from a later `main` commit: that would build a different
source tree for an immutable version. Start **Publish npm package** from `main`
with `recovery_run_id` set to the failed run's numeric GitHub Actions ID. The
workflow reads that run's `head_sha`, confirms it was a failed main dispatch of
this workflow, checks out that commit, and then verifies or creates the matching
`v<version>` tag before creating the GitHub Release. It rejects an
already-published version without that verified recovery run, and it refuses to
publish a missing version during recovery.

The engine step is idempotent on its own version: it skips a version already on
npm and publishes one that is missing, so a recovery run completes an engine
upload that failed after `supervision` was published.
