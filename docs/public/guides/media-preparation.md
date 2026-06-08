---
title: Media Preparation
group: Guides
summary: Probe uploaded media and normalize it into a browser-renderable profile.
---

# Media Preparation

`supervision-js` treats media preparation as part of the rendering foundation.
For uploaded files, the browser may not be able to decode the input efficiently
or consistently. The preparation APIs probe the file, choose a supported target,
and normalize the video before rendering or inference workflows depend on it.

## Probe First

Use `probeMedia()` when the app wants to inspect browser support and explain
problems before starting normalization:

```ts
const probe = await probeMedia(file);

if (probe.status === MediaProbeStatus.Unsupported) {
  console.warn(probe.issues);
}
```

## Full Preparation

Use `prepareMedia()` when the app can wait for a complete normalized blob:

```ts
const prepared = await prepareMedia(file);

const objectUrl = URL.createObjectURL(prepared.normalizedMedia.blob);
```

This path is simple and useful for short files, export workflows, and tests.

## Progressive Preparation

Use `prepareMediaProgressively()` when the app wants a renderer source as bytes
are produced:

```ts
const prepared = await prepareMediaProgressively(file, {
  normalization: {
    video: { frameRate: 30 },
  },
});

const session = await createMediaSession({
  container,
  media: prepared.normalizedMedia.rendererSource,
});
```

The progressive result also exposes `completion`, which resolves to the final
normalized blob when conversion finishes.

## Session Shortcut

For the common viewer path, `createMediaSession()` can perform progressive
normalization directly:

```ts
const session = await createMediaSession({
  container,
  media: file,
  normalize: { stream: true },
});
```

This keeps media decoding and annotation rendering in the same renderer-owned
composition while the normalized media becomes available.
