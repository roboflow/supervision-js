# Image-Backed Render Deployment

The public demo runs at
[`https://supervision-js-demo.onrender.com`](https://supervision-js-demo.onrender.com).

It is intentionally deployed as a prebuilt image instead of through Render's
GitHub source integration. This keeps Render independent of the GitHub App's
access to the private `roboflow/supervision-js` repository.

## Delivery Path

1. A push to `main` runs `.github/workflows/deploy-demo.yml`.
2. The workflow checks out LFS fixture assets, builds `Dockerfile` for
   `linux/amd64`, and publishes both an immutable SHA tag and the `main` tag to
   `ghcr.io/roboflow/supervision-js-demo`.
3. The workflow calls a Render deploy hook with the immutable SHA tag.
4. Render pulls and deploys that image without cloning the repository.

The production container runs `npm run demo:build` at build time and serves the
demo, TypeDoc site at `/docs`, vanilla example at `/examples/vanilla`, and the
demo's SAM3 proxy endpoints from the existing production Node server.

## One-Time Service Setup

The Render service is `srv-d8felq6gvqtc7398i2ng` (`supervision-js-demo`).

Because the GitHub repository is private, the GHCR image should stay private.
Create a Render registry credential with read-only access to
`ghcr.io/roboflow/supervision-js-demo`, then switch the existing service to the
image source. The service URL stays the same.

```bash
render services update srv-d8felq6gvqtc7398i2ng \
  --image ghcr.io/roboflow/supervision-js-demo:main \
  --registry-credential <render-registry-credential-id> \
  --confirm
```

The image must be published once before running that command. The workflow's
first `main` run creates it.

Create a Render deploy hook for the service, then store its full URL as the
repository Actions secret `RENDER_DEPLOY_HOOK_URL`. The workflow sends the
SHA-qualified image through the hook's `imgURL` query parameter, so each
deployment is pinned to exactly the image built from that commit.

The required GitHub permissions are:

- Actions `packages: write` for the workflow's built-in `GITHUB_TOKEN`;
- an administrator to add the `RENDER_DEPLOY_HOOK_URL` Actions secret;
- a Render registry credential that can pull the private GHCR image.

No Render GitHub repository connection is required after the service has been
switched to the image source.

## Manual Recovery

To redeploy a known image manually, use the service's Render deploy hook with
the same repository path and an immutable image tag:

```bash
curl --fail --get \
  --data-urlencode "imgURL=ghcr.io/roboflow/supervision-js-demo:<commit-sha>" \
  "$RENDER_DEPLOY_HOOK_URL"
```

This is preferable to using the mutable `main` tag when diagnosing a release.
