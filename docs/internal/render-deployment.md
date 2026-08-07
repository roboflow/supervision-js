# Render Preview Deployment

GitHub Pages is the public static deployment for this repository. The existing
Render web service is reserved for explicitly requested pull request previews:

- service: `supervision-js-demo`
- resource ID: `srv-d8felq6gvqtc7398i2ng`
- base service URL: <https://supervision-js-demo.onrender.com>
- repository: <https://github.com/roboflow/supervision-js>
- branch: `main`

The canonical repository is the only source of truth. Do not introduce or push
to a deployment mirror.

## Service Configuration

Use these settings:

```text
Branch: main
Runtime: Node
Build command: npm ci && npm run pages:build
Start command: npm run pages:serve
Auto-deploy: Off
Pull request previews: Manual
```

`Auto-deploy: Off` is intentional: merging to `main` must not deploy the
Render base service. Leave it disabled when reconciling service settings.

With pull request previews set to `Manual`, applying the `render-preview`
label to a PR creates a separate temporary Render instance for that PR. Render
adds the preview as a GitHub deployment with its own `onrender.com` URL. It
updates that preview when the PR receives new commits and removes it when the
PR is merged or closed.

`npm run pages:build` produces the static artifact used by both GitHub Pages
and a requested Render preview:

- `/` contains the TypeDoc site and interactive playground;
- `/demo/` contains the fixture demo workbench;
- `/examples/vanilla/` contains the vanilla integration example.

The static applications use relative asset URLs, so the same artifact works at
the root of a Render preview or under GitHub Pages' project URL.

## Request a Preview

1. Open or update a PR against `main`.
2. Add the `render-preview` label.
3. Wait for Render to add the GitHub deployment, then open its preview URL.

Remove the label to deprovision a preview that is no longer needed. Do not use
the base service's manual deploy controls for PR validation: they deploy the
shared base service rather than an isolated PR preview.

## Verify a Preview

After Render reports the preview as live, check its GitHub deployment URL:

```sh
curl --fail --location "<render-preview-url>/"
curl --fail --location "<render-preview-url>/demo/"
curl --fail --location "<render-preview-url>/examples/vanilla/"
```

The root must show the docs homepage, the demo route must load the fixture
workbench, and the vanilla route must load the integration example.
