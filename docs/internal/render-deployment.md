# Render Deployment

The public demo and documentation are served by the existing Render web service:

- service: `supervision-js-demo`
- resource ID: `srv-d8felq6gvqtc7398i2ng`
- URL: <https://supervision-js-demo.onrender.com>
- docs: <https://supervision-js-demo.onrender.com/docs/>

The service deploys `main` from
`https://github.com/roboflow/supervision-js`.

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

## Update With The Render CLI

After authenticating with `render login`, the existing service can be reconciled
without creating a replacement resource:

```sh
render services update srv-d8felq6gvqtc7398i2ng \
  --repo https://github.com/roboflow/supervision-js \
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

The Application Integration page must describe tarball installation, and the
Editing module must appear in the generated API reference. Those checks
distinguish the current documentation from the stale personal-fork deployment
that preceded this configuration.
