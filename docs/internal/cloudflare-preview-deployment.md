# Cloudflare Preview Deployment

Cloudflare Pages provides opt-in pull request previews. Production remains on
GitHub Pages.

## Flow

1. A maintainer adds the `cloudflare-preview` label to a pull request.
2. `.github/workflows/cloudflare-preview-branch.yml` creates or updates
   `preview/pr-<number>` at the pull request's exact head SHA.
3. The Cloudflare Pages Git integration builds only `preview/*` branches with
   `npm run pages:build` and publishes a stable branch alias:
   `https://preview-pr-<number>.supervision-js-preview.pages.dev/`.
4. Cloudflare reports the build through a GitHub check run.
5. `.github/workflows/cloudflare-preview-status.yml` edits one sticky pull
   request comment with the deployed link or the Cloudflare failure details.
6. Removing the label or closing the pull request deletes the synthetic Git
   branch.

The `pull_request_target` workflow never checks out or executes pull request
code. It only updates a repository ref after a maintainer applies the label.
The untrusted commit is built later in the secret-free Cloudflare Pages build
environment. Neither workflow receives Cloudflare credentials.

The status reporter ignores stale check runs by comparing the completed check's
SHA with the current synthetic branch ref before editing the comment.

## Infrastructure boundary

The private `roboflow/roboflow-infra` repository owns:

- the `supervision-js-preview` Pages project and GitHub source configuration;
- the `roboflow-supervision-js-public-assets` R2 bucket;
- `assets.supervision.roboflow.com`; and
- the bucket's public read-only browser CORS policy.

The Pages project has automatic production deployments disabled and custom
preview branch controls that include only `preview/*`.

The 134 MB horse-trail source video exceeds Cloudflare Pages' per-file limit.
The demo therefore resolves that committed fixture source from:

```text
https://assets.supervision.roboflow.com/fixtures/horse_trail/1min-horse-video.mov
```

`VITE_DEMO_HORSE_TRAIL_VIDEO_URL` may override the origin in a Pages build.
The local source remains committed for fixture regeneration and offline test
work, but it is excluded from the deployed static artifact.

## Bootstrap

Before enabling the first preview:

1. Apply the corresponding `roboflow-infra` stack.
2. Authorize the Cloudflare Workers and Pages GitHub App for this repository.
3. Upload the horse-trail object to its documented R2 key and verify the public
   URL.
4. Create the `cloudflare-preview` repository label.
5. Add the label to a pull request and confirm the queued comment changes to a
   success or failure result for the same head SHA.

Cloudflare's GitHub App needs access to the repository, but this repository
does not need an API token, account ID, R2 credential, or Pages credential.
