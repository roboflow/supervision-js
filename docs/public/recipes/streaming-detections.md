---
title: Streaming Detections
group: Recipes
summary: Append detections as inference results arrive over time.
---

# Streaming Detections

Use an appendable detection source when predictions arrive after playback has
started. This fits uploaded videos, live inference, webcam sessions, and
server-sent inference results.

```ts
import {
  createMediaSession,
  DetectionFrameRetentionMode,
  type DetectionFrame,
} from "supervision";

const session = await createMediaSession({
  container,
  media: file,
  detections: {
    appendable: {
      datasetId: "upload-1",
      retention: {
        mode: DetectionFrameRetentionMode.PersistAll,
      },
    },
  },
  normalize: { stream: true },
  renderer: {
    autoPlay: true,
  },
});

for await (const frames of streamInferenceFrames(file)) {
  await session.appendDetectionFrames(frames);
}
```

A session holds for its predictions and for the artifacts that draw them by
default, so a preview opens annotated rather than opening bare and filling in.
Pass `playbackGate: false` to `createMediaSession` when you would rather the
picture keep moving and the annotations land as they arrive: a frame the source
does not cover yet then presents without annotations and draws them when the
append covering it lands, so inference falling behind slows annotations rather
than the video.
That one switch answers for `detections.playbackGate` and
`renderer.renderPreparation.playbackGate` together; set either one's `enabled`
to answer for that gate alone, or its `requiredAheadSeconds` to tune the
lookahead it waits for.

### Which Sources The Gate Reaches

The sustained gate is the renderer holding a decoded sample back before it
draws it. It lasts the length of playback wherever the renderer pulls samples,
which is the case for the `media` inputs above: a URL, a `File`, or a `Blob`.

A media source that presents its own frames owns the playhead, and the renderer
follows it rather than pacing it. `createVideoEngineMediaRendererSource` and
`openVideoEngineMediaSource` return that kind of source, and they are what most
hosts render video through. There the render-preparation gate holds the start of
playback and nothing after it, while the detection gate stops the producer again
at any frame its detections do not cover and starts it when they land. Wait on
coverage yourself when you would rather decide where playback stops:

```ts
await session.detectionSource?.waitForRange?.({ startTime: 0, endTime: 2 });
await session.play();
```

## Appending Results

Append semantic frames in batches. The batch can contain one frame or many
frames:

```ts
async function appendInferenceResult(frame: DetectionFrame) {
  await session.appendDetectionFrames([frame]);
}
```

Appending detections outside the current hot window does not force the renderer
to reload the active window. The session tracks source ranges and refreshes when
the relevant playback range changes.

## Retention Modes

For finite files, use `PersistAll` so seeking and replay do not require
recomputing predictions.

For long-running streams, use a rolling retention window:

```ts
retention: {
  mode: DetectionFrameRetentionMode.PersistWindow,
  windowSeconds: 300,
}
```

Use `MemoryOnly` for fully ephemeral streams:

```ts
retention: {
  mode: DetectionFrameRetentionMode.MemoryOnly,
  windowSeconds: 60,
}
```

## Loading State

Subscribe to session state to show buffering or processing UI:

```ts
session.subscribe((state) => {
  playButton.disabled = state.playbackBlocked;

  for (const activity of state.activities) {
    console.log(activity.kind, activity.label, activity.progress);
  }
});
```

`playbackBlocked` means playback should wait; media buffering and session errors
raise it. Detection coverage raises it only through an enabled detection gate,
so `playbackGate: false` keeps coverage from blocking playback at all.
`presentationBlocked` means the visual frame is still preparing an artifact
while playback continues.
