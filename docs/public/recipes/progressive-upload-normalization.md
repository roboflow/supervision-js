---
title: Progressive Upload Normalization
group: Recipes
summary: Normalize uploaded media while the session becomes renderable.
---

# Progressive Upload Normalization

Use progressive normalization when a user uploads media that may not be browser
or inference friendly. The session can normalize the file with Mediabunny and
expose renderer-readable output as bytes become available.

```ts
import { createMediaSession } from "supervision";

const session = await createMediaSession({
  container,
  media: uploadedFile,
  normalize: {
    stream: true,
    audio: { discard: true },
    video: {
      frameRate: 30,
      forceTranscode: true,
    },
  },
  renderer: {
    autoPlay: true,
    loop: true,
  },
});
```

## Track Progress

Use `session.subscribe()` to track normalization, playback gates, and render
preparation:

```ts
import { MediaSessionActivityKind } from "supervision";

session.subscribe((state) => {
  const normalizing = state.activities.find(
    (activity) => activity.kind === MediaSessionActivityKind.MediaNormalizing,
  );

  if (normalizing?.progress) {
    progress.value = normalizing.progress.progress;
  }
});
```

Background normalization is not automatically a blocking overlay. A consuming
app can decide whether to show it as a progress bar, compact status chip, or
debug readout.

## Probe Without Creating A Session

Use `prepareMediaProgressively()` when the app wants preparation as a separate
step:

```ts
import { prepareMediaProgressively } from "supervision";

const prepared = await prepareMediaProgressively(uploadedFile, {
  normalization: {
    audio: { discard: true },
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

## Pair With Streaming Detections

For inference workflows, start the session with an appendable detection source
and append predictions as normalized frames become available:

```ts
const session = await createMediaSession({
  container,
  detections: {
    appendable: {
      datasetId: "upload-1",
    },
  },
  media: uploadedFile,
  normalize: { stream: true },
});

await session.appendDetectionFrames(predictedFrames);
```

The important boundary: the app owns inference requests; `supervision-js` owns
media preparation, detection ingestion, buffering, prepared artifacts, and
renderer-owned presentation.
