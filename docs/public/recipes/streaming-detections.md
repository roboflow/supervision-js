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

Playback does not wait for appended detections. A frame the source does not
cover yet presents without annotations and draws them when the append covering
it lands, so inference falling behind slows annotations rather than the video.

Pass `detections.playbackGate: { enabled: true, requiredAheadSeconds }` when you
would rather the video hold for its predictions. It is off by default, so a
session that never mentions it keeps the picture moving.

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
raise it, and detection coverage never does. `presentationBlocked` means the
visual frame is still preparing an artifact while playback continues.
