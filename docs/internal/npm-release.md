# npm Release Operations

This repository publishes one public package: `supervision`. The root workspace,
`supervision-js-trackers`, `supervision-js-core`,
`supervision-js-web-video-engine`, and `supervision-js-react-native` remain
private. The tracker workspace is compiled into core, and the web video engine
is staged into the browser package's `dist`, rather than shipped as further
installable packages.

`supervision` is published as the portable tarball assembled by
`tools/pack-web-tarball.mjs`; it embeds the private core package without
exposing the workspace-relative `file:../core` dependency, and carries the video
engine under the `supervision/web-video-engine` subpaths.

## Release Boundary

Never publish from `packages/web` directly. A release publishes exactly one
generated file:

```text
artifacts/supervision-<version>.tgz
```

The GitHub Actions workflow at `.github/workflows/publish-npm.yml` recreates
and independently validates that artifact before publishing it. A push to `main`
that changes the browser manifest to an unpublished version runs it
automatically; a manual run publishes the selected branch as it is. Stable
`latest` releases run only from `main`; an explicit prerelease may run from a
`release/*` branch with the `next` tag. Every publish is gated by the
`npm-publish` GitHub environment.

`latest` is the default tag for a reviewed, general-availability release. A
stable publish updates the default version that `npm install supervision`
resolves.

`packages/web/package.json` carries the release identity: the stable release
workflow creates the matching GitHub Release and `v<version>` tag from the
`main` commit that npm published. That release page is the canonical GitHub
record; npm is the canonical installation source. The private workspaces have no
version of their own that anyone can install.

## Publication Access

The package name is `supervision`; the repository remains `supervision-js`. Keep
this ownership and security posture in place:

1. At least two active Roboflow maintainers have npm package access and two-factor
   authentication.
2. npm **Trusted publisher** points exactly to GitHub Actions organization
   `roboflow`, repository `supervision-js`, workflow `publish-npm.yml`, and
   environment `npm-publish` for the **npm publish** action.
3. GitHub's `npm-publish` environment requires release-owner approval.
4. The separate `github-release` job uses GitHub Actions' automatic
   `GITHUB_TOKEN` with **Contents: write** to create the tag and GitHub Release.
   The npm job has **Contents: read** and **id-token: write**. No personal
   access token, dedicated GitHub App, or manually configured GitHub secret is
   needed. Both jobs check out the exact workflow commit, and checkout uses
   `persist-credentials: false`.
5. No long-lived npm write token is stored in GitHub. Publishing uses OIDC.

If publishing access breaks, compare the trusted-publisher fields with the
workflow before changing credentials. The npm trusted-publisher configuration is
separate from GitHub tag and release authentication. After merging this
workflow, remove the obsolete `RELEASE_GITHUB_TOKEN` secret. No replacement
secret or variable is required.

## Choose The Version And Tag

Version `supervision` with SemVer against its published surface:

| Change                                                                                           | Example version from `0.1.7` | Tag      |
| ------------------------------------------------------------------------------------------------ | ---------------------------- | -------- |
| Backward-compatible fix, docs, dependency maintenance, internal refactor, or public API addition | `0.1.8`                      | `latest` |
| Breaking public API or behavior change before 1.0                                                | `0.2.0`                      | `latest` |

While the package remains in the experimental `0.x` line, backward-compatible
public API additions release as patches alongside fixes. A new minor version
communicates an intentional compatibility break or reset before `1.0`. This is
the repository's release policy for the prototype phase; SemVer itself treats
`0.y.z` as initial development. Changes limited to private React Native
experiments do not by themselves change the published version.

## Release Procedure

1. In GitHub Actions, run **Publish npm package** from `main` and enter the
   next version, such as `0.2.18`, or `patch` or `minor`. The run summary shows
   the current `main` and npm `latest` versions next to the one requested.
   The workflow refuses a version that does not move past both, that npm
   already has, or whose tag exists.
2. The workflow runs `npm run release:version -- <version>`, which updates
   `packages/web/package.json`, `package-lock.json`, the checked docs toolbar
   version, and the install line of the matching migration guide together.
   `npm run docs:check` verifies the toolbar mirror against the browser
   manifest. A new minor line needs its migration guide written by hand; the
   script reports when one is missing.
3. It pushes `release-prep/v<version>`, opens the release pull request with a
   preview of the generated release notes, and dispatches CI on that branch. A
   pull request opened with the automatic token starts no workflows of its own,
   so the dispatched run is what reports the required `verify` check. Opening
   the pull request requires the repository setting **Allow GitHub Actions to
   create and approve pull requests**; without it the run fails after pushing
   the branch and prints the compare link to open it by hand.
4. Review and merge the release pull request. Anything that should ship in the
   release must merge first: the notes are generated from `main`.
5. The merge changes the manifest version on `main`, which starts **Publish npm
   package** again. It verifies, packs, smoke-tests, and publishes the
   generated archive through npm trusted publishing after the `npm-publish`
   environment approves the deployment, waits for `latest` to propagate,
   creates the matching annotated Git tag, and creates the matching GitHub
   Release with generated notes. A push that leaves the version at one npm
   already has, such as a dependency update, stops before the publish job.
6. Verify npm metadata, provenance, tarball contents, and a clean installation
   in a separate consumer:

   ```sh
   npm view supervision dist-tags --json
   npm view supervision@<version> version
   npm pack supervision@<version>
   ```

7. Confirm that the GitHub Release `v<version>` points at the same `main`
   commit the workflow published. Then verify that public installation guidance,
   the toolbar version, and the documentation deployment match the stable
   release.

Consumer installation guidance is always `npm install supervision`; do not
document local archive paths for consumers. To check a release locally before
dispatching, run the same steps the workflow and CI run:

```sh
npm run release:version -- <version>
npm run verify
npm run package:tarball
npm run package:tarball:smoke
npm run package:publish:dry-run
```

### Prerelease Procedure

Use a dedicated `release/*` branch when an integration needs to consume an
unmerged commit. Set the unique SemVer prerelease with
`npm run release:version -- 0.2.0-next.0`, which updates the manifest, lockfile,
and docs toolbar mirror and leaves the stable install line alone, then run
**Publish npm package** from that release branch with an empty version and
`next`. npm versions are immutable: each later prerelease needs a new version
such as `0.2.0-next.1`; the `next` dist-tag moves to that newest version. A release
branch can never publish `latest` or create a stable GitHub Release.

## Recovery

If publishing fails before uploading the package, use **Re-run failed jobs** on
that run when the failure was transient. Otherwise fix it in a pull request,
then run **Publish npm package** from `main` with an empty version and `latest`:
the merge of the fix does not change the manifest version, so it does not
publish by itself. npm versions are immutable once
published: never try to overwrite one. Publish a new patch version instead.

If npm publishing succeeds but the `github-release` job fails, use **Re-run
failed jobs** on that original workflow run. The successful npm job is not
repeated, and the release job uses the original run's commit. Do not dispatch a
new publish or rebuild the same immutable npm version from a later commit.
