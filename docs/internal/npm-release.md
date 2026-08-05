# npm Release Operations

This repository publishes one public package: `supervision-js`. The root
workspace, `supervision-js-core`, and `supervision-js-react-native` remain
private. The npm registry artifact is the portable tarball assembled by
`tools/pack-web-tarball.mjs`; it embeds the private core package without
exposing the workspace-relative `file:../core` dependency.

## Release Boundary

Never publish from `packages/web` directly. A release must publish exactly one
generated file matching:

```text
artifacts/supervision-js-<version>.tgz
```

The manual GitHub Actions workflow at
`.github/workflows/publish-npm.yml` recreates and independently validates that
artifact before publishing it. It accepts only the `next` and `latest` tags,
runs only from `main`, and is gated by the `npm-publish` GitHub environment.

`next` is the safe default for the first release. Promote a version to `latest`
only after the release owner explicitly makes that decision.

## One-Time Bootstrap

The package name is `supervision-js`, not `supervision`. The separately owned
`supervision` npm package does not block this package's release.

Before the first automated release, an npm administrator must:

1. Confirm that `supervision-js` is available or arrange a transfer if its
   ownership changes.
2. Create or use the Roboflow npm owner that will own the first public release,
   with two-factor authentication enabled.
3. Publish the reviewed generated tarball once using that administrator's
   interactive npm authentication. This claims the package; it is the only
   bootstrap exception to the trusted-publisher flow.
4. Add at least two active Roboflow maintainers to the npm package.
5. Open the package's npm **Settings → Trusted publisher** and configure:
   - provider: **GitHub Actions**;
   - organization: `roboflow`;
   - repository: `supervision-js`;
   - workflow filename: `publish-npm.yml`;
   - environment name: `npm-publish`;
   - allowed action: **npm publish**.
6. In GitHub, create the `npm-publish` environment and require approval from
   the release owners. Do not store an npm write token in GitHub secrets.
7. After one successful OIDC publish, set npm **Publishing access** to require
   two-factor authentication and disallow tokens, then remove any obsolete
   automation tokens.

The trusted publisher must match the organization, repository, workflow file,
and environment name exactly. Each npm package supports one trusted publisher.

## Release Procedure

1. Update the public package version in `packages/web/package.json` and refresh
   `package-lock.json`.
2. Run the normal validation plus the clean-consumer artifact smoke test:

   ```sh
   npm run verify
   npm run package:tarball
   npm run package:tarball:smoke
   npm run package:publish:dry-run
   ```

3. Merge the reviewed release-preparation pull request to `main`.
4. In GitHub Actions, run **Publish npm package** from `main`. Select `next`
   unless the release owner has explicitly approved `latest`.
5. Approve the `npm-publish` environment deployment. The workflow verifies,
   packs, smoke-tests, and then publishes the generated archive through npm
   trusted publishing (OIDC). It has no long-lived npm credential.
6. Verify the published package metadata, provenance, tarball contents, and a
   clean installation in a separate consumer. Then update public installation
   docs from the local-tarball instructions to `npm install supervision-js`.

## Recovery

If a publish fails before uploading the package, fix the failure in a pull
request and rerun the workflow from `main`. npm versions are immutable once
published: never try to overwrite one. Publish a new patch version instead.

If OIDC authentication fails, compare the npm trusted-publisher configuration
with the workflow's organization, repository, filename, and environment. Do
not work around the issue by adding a long-lived npm write token to GitHub.
