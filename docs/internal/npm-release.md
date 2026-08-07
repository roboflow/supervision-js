# npm Release Operations

This repository publishes one public package: `supervision`. The root
workspace, `supervision-js-core`, and `supervision-js-react-native` remain
private. The registry artifact is the portable tarball assembled by
`tools/pack-web-tarball.mjs`; it embeds the private core package without
exposing the workspace-relative `file:../core` dependency.

## Release Boundary

Never publish from `packages/web` directly. A release publishes exactly one
generated file matching:

```text
artifacts/supervision-<version>.tgz
```

The manual GitHub Actions workflow at
`.github/workflows/publish-npm.yml` recreates and independently validates that
artifact before publishing it. It runs only from `main` and is gated by the
`npm-publish` GitHub environment.

`latest` is the default tag for a reviewed, general-availability release.
`next` is reserved for an explicit prerelease or canary. Do not use `next` as a
holding area for a stable release: a stable publish with `latest` updates the
default version that `npm install supervision` resolves.

The `packages/web/package.json` version is the source of truth. The stable
release workflow creates the matching GitHub Release and `v<version>` tag from
the `main` commit that npm published. That release page is the canonical GitHub
record; npm is the canonical installation source.

## Publication Access

The package name is `supervision`; the repository remains `supervision-js`.
Keep this ownership and security posture in place:

1. At least two active Roboflow maintainers have npm package access and two-factor
   authentication.
2. npm **Trusted publisher** points exactly to GitHub Actions organization
   `roboflow`, repository `supervision-js`, workflow `publish-npm.yml`, and
   environment `npm-publish` for the **npm publish** action.
3. GitHub's `npm-publish` environment requires release-owner approval.
4. No long-lived npm write token is stored in GitHub. Publishing uses OIDC.

If publishing access breaks, compare the trusted-publisher fields with the
workflow before changing credentials. Each npm package supports one trusted
publisher.

## Choose The Version And Tag

Use SemVer against the published browser surface only:

| Change                                                                      | Example next version from `0.1.0` | Tag      |
| --------------------------------------------------------------------------- | --------------------------------- | -------- |
| Backward-compatible fix, docs, dependency maintenance, or internal refactor | `0.1.1`                           | `latest` |
| Backward-compatible public browser API addition                             | `0.2.0`                           | `latest` |
| Breaking browser API or behavior change before 1.0                          | `0.2.0`                           | `latest` |
| Preview of a future release                                                 | `0.1.2-rc.0`                      | `next`   |

For pre-1.0 versions, a new minor version communicates a breaking public
change. Changes limited to private React Native experiments do not by themselves
change the published browser package version.

## Release Procedure

1. Update `packages/web/package.json`, `package-lock.json`, and the checked docs
   toolbar version together. `npm run docs:check` verifies the toolbar mirror.
   Before the npm publication, the toolbar must label that version as pending;
   the post-publication docs-only follow-up removes that label.
2. Keep the public repository README and hosted docs on the currently live npm
   channel until the stable publish has completed. Before the first browser
   package owns `latest`, that is `npm install supervision@next`; do not
   document path installs of release tarballs for consumers. The package README
   published in this release may use `npm install supervision`, because it only
   becomes visible after that stable publication.
3. Run the normal validation plus the clean-consumer artifact smoke test:

   ```sh
   npm run verify
   npm run package:tarball
   npm run package:tarball:smoke
   npm run package:publish:dry-run
   ```

4. Merge the reviewed release-preparation pull request to `main`.
5. In GitHub Actions, run **Publish npm package** from `main` and select
   `latest` for a stable release. Approve the `npm-publish` environment
   deployment. The workflow verifies, packs, smoke-tests, publishes the
   generated archive through npm trusted publishing, verifies the selected npm
   tag, and creates the matching GitHub Release.
6. Verify npm metadata, provenance, tarball contents, and a clean installation
   in a separate consumer:

   ```sh
   npm view supervision dist-tags --json
   npm view supervision@<version> version
   npm pack supervision@<version>
   ```

7. Confirm that the GitHub Release `v<version>` points at the same `main`
   commit the workflow published. Then merge a docs-only follow-up that changes
   the public repository README and hosted docs from
   `npm install supervision@next` to `npm install supervision`, removes the
   toolbar's pending-release label, and verifies the documentation deployment.

## Clear A Previous `next` Tag

Publishing `0.1.1` with `latest` does not remove `next`; npm dist-tags are
independent. After the stable publish and docs-only follow-up are verified,
remove a stale preview tag only when no release process still relies on it:

```sh
npm dist-tag ls supervision
npm dist-tag rm supervision next
npm dist-tag ls supervision
```

This does not unpublish `0.1.0`; it only removes the `next` alias. For the next
preview cycle, publish a new prerelease version such as `0.1.2-rc.0` with the
`next` tag.

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
