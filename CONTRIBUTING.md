# Contributing to supervision-js

Thanks for helping improve `supervision-js`. We welcome bug reports,
documentation corrections, examples, performance investigations, and focused
code contributions.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Keep browser renderer changes aligned with the session-first public API.
- Video presentation is push-based and its atomic present is law for later
  edits. Read
  [video-engine-presentation.md](docs/internal/video-engine-presentation.md)
  before changing video, the annotation window, or the render policy.
- Do not expose PixiJS, Mediabunny, worker, or prepared-artifact internals as
  public API without a concrete consumer need.
- Treat React Native as experimental and keep it independent of the browser
  package.

For project boundaries and commands, read
[docs/internal/agent-guidance.md](docs/internal/agent-guidance.md).

Contributions that add visualization recipes or annotator-style facades should
also follow the
[annotator use-case roadmap](docs/internal/annotator-use-case-roadmap.md),
including its one-annotator-per-PR and frozen-fixture requirements.

## Local Development

Use Node.js 20.19 or newer.

```sh
npm install
npm run dev
```

`npm run dev` keeps the package build watchers running beside the demo server.
A demo-only server does not, and the demo runs the built package, so read
[the build note in agent-guidance](docs/internal/agent-guidance.md#the-demo-runs-the-built-package)
before iterating on library source any other way.

Useful checks:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run verify
```

`npm run verify` is the full local validation suite used by CI. For package
changes, also run:

```sh
npm run package:tarball
npm run package:tarball:smoke
```

The tarball smoke test verifies an external consumer; a monorepo build alone is
not enough to prove package portability.

## Pull Requests

Keep each pull request focused and include:

- a concise explanation of the user or maintainer impact;
- tests for behavior changes, or an explanation of why tests are unnecessary;
- documentation updates for public API or workflow changes;
- screenshots or a short recording for visual demo/docs changes;
- performance evidence when changing a renderer hot path.

Run the relevant checks before requesting review. Maintainers may ask to split
unrelated refactors from behavioral changes so they can be reviewed safely.

## Documentation And Examples

Public API changes must update the corresponding facade under
`docs/public/api/` and the relevant guide or recipe. Keep copyable examples
browser-safe and avoid requiring a Roboflow API key unless the guide explicitly
describes that integration.

## Reporting Security Issues

Do not open a public issue for a suspected vulnerability. See
[SECURITY.md](SECURITY.md) for the private reporting path.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
