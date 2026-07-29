# GitHub Pages Deployment

The public proof of concept is deployed as a static GitHub Pages site. A push
to `main` runs `.github/workflows/deploy-pages.yml` with no repository secrets.

The same `dist/pages` artifact is also served publicly by the existing Render
resource. See [Render Deployment](render-deployment.md) for that service's
source and runtime configuration.

`npm run pages:build` assembles `dist/pages` with this layout:

- `/` contains the fixture-only demo;
- `/docs/` contains the TypeDoc site;
- `/examples/vanilla/` contains the minimal vanilla example.

The workflow checks out Git LFS assets before building, then uses the standard
GitHub Pages artifact and deployment actions. GitHub Pages must be configured
once in repository settings with **Source: GitHub Actions**.

The Pages demo deliberately hides Upload media. Uploaded-media normalization and
SAM3 requests require the local Vite proxy in `demo/server/roboflow-sam3-plugin.ts`.
Use `npm run demo:dev` for that local-only flow.
