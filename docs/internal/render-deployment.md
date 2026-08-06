# Render Deployment

The public demo and documentation are served by the existing Render web service:

- service: `supervision-js-demo`
- resource ID: `srv-d8felq6gvqtc7398i2ng`
- URL: <https://supervision-js-demo.onrender.com>
- docs: <https://supervision-js-demo.onrender.com/docs/>

The canonical source remains
`https://github.com/roboflow/supervision-js`. Render currently deploys the same
`main` commit from the deployment mirror at
`https://github.com/joaomarcoscrs/supervision-js-render`.

Do not develop in or merge changes into the mirror. Push the canonical `main`
commit to it only after the canonical push succeeds:

```sh
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git push git@github.com:joaomarcoscrs/supervision-js-render.git main:main
```

This preserves a single source of truth. When Infra gives Render access to
`roboflow/supervision-js`, point the service back to the canonical repository
and retire the mirror.

## Service Configuration

Use these settings:

```text
Branch: main
Runtime: Node
Build command: npm ci && npm run pages:build
Start command: npm run pages:serve
Auto-deploy: On commit
```

`npm run pages:build` creates one static artifact in `dist/pages`:

- `/` contains the fixture demo;
- `/docs/` contains the TypeDoc site;
- `/examples/vanilla/` contains the vanilla integration example.

`npm run pages:serve` serves that same artifact on Render's `PORT`. This keeps
the Render and GitHub Pages output identical and avoids maintaining a second
production server or image delivery path.

The start command passes Render's exact `RENDER_EXTERNAL_HOSTNAME` to Vite's
additional-host allowlist. This supports branch preview services without
trusting arbitrary hosts; local runs fall back to the canonical production
hostname.

## Update With The Render CLI

After authenticating with `render login`, the existing service can be
reconciled without creating a replacement resource:

```sh
render services update srv-d8felq6gvqtc7398i2ng \
  --repo https://github.com/joaomarcoscrs/supervision-js-render \
  --branch main \
  --runtime node \
  --build-command "npm ci && npm run pages:build" \
  --start-command "npm run pages:serve" \
  --auto-deploy \
  --confirm \
  --output json
```

Then trigger a deploy if the configuration update does not start one:

```sh
render deploys create srv-d8felq6gvqtc7398i2ng --confirm
```

## Verify

Check the deployed routes after Render reports the deploy as live:

```sh
curl --fail --location https://supervision-js-demo.onrender.com/
curl --fail --location https://supervision-js-demo.onrender.com/docs/
curl --fail --location \
  https://supervision-js-demo.onrender.com/docs/documents/Application_Integration.html
curl --fail --location \
  https://supervision-js-demo.onrender.com/docs/modules/Editing.html
curl --fail --location \
  https://supervision-js-demo.onrender.com/examples/vanilla/
```

The Application Integration page must describe `npm install supervision`, and
the Editing module must appear in the generated API reference. Also verify that
the live Render deploy's commit matches both canonical `main` and mirror `main`.
Those checks distinguish the current documentation from the stale deployment
that preceded this configuration.
