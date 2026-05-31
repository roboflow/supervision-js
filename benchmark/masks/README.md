# Mask Artifact Benchmark

Programmatic benchmark for mask rendering strategy decisions.

This benchmark consumes the deterministic basketball SAM3 fixture and measures
CPU artifact preparation cost plus transfer/upload-size pressure for:

- current RGBA composited mask artifacts;
- current RGBA composited mask artifacts with mask borders;
- an ID-mask artifact candidate for future shader/palette styling.

Run from the repo root:

```bash
npm run benchmark:masks
```

The benchmark writes JSON and Markdown summaries to `benchmark/masks/results/`.
Timing numbers are local-machine measurements; bytes and fixture stats are
stable for the checked-in fixture.

Tracked summary findings live in [`findings.md`](findings.md) and
[`findings.csv`](findings.csv). Regenerate the local detailed report before
updating those files.
