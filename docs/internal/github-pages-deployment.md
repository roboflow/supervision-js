# GitHub Pages Deployment

The public proof of concept is deployed as a static GitHub Pages site. A push
to `main` runs `.github/workflows/deploy-pages.yml` with no repository secrets.

The same `dist/pages` artifact is used for label-gated Cloudflare Pages pull
request previews. See
[Cloudflare Preview Deployment](cloudflare-preview-deployment.md).

`npm run pages:build` assembles `dist/pages` with this layout:

- `/` contains the TypeDoc site and its interactive playground;
- `/demo/` contains the fixture-only demo workbench;
- `/examples/vanilla/` contains the minimal vanilla example.

The fixture demo and vanilla example use relative application asset URLs. The
large horse-trail source video is served separately from the public R2 fixture
origin so the artifact remains below static-host per-file limits.

The workflow checks out Git LFS assets before building, then uses the standard
GitHub Pages artifact and deployment actions. GitHub Pages must be configured
once in repository settings with **Source: GitHub Actions**.

The Pages demo deliberately hides Upload media. Uploaded-media normalization and
SAM3 requests require the local Vite proxy in `demo/server/roboflow-sam3-plugin.ts`.
Use `npm run demo:dev` for that local-only flow.
