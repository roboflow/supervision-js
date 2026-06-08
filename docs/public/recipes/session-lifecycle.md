---
title: Session Lifecycle
group: Recipes
summary: Create, replace, and destroy media sessions without leaking renderer work.
---

# Session Lifecycle

Treat a `MediaSession` as the runtime owner for one media item. It owns media
preparation, the Pixi scene, playback state, detection buffering, prepared
render artifacts, and interaction handlers for that item.

## Replace A Media Item

Destroy the current session before creating the next one in the same container:

```ts
import {
  createMediaSession,
  MediaSessionStatus,
  type MediaSession,
} from "supervision-js";

let session: MediaSession | null = null;

async function openMedia(file: File) {
  session?.destroy();

  session = await createMediaSession({
    container,
    media: file,
    renderer: {
      autoPlay: true,
      loop: true,
    },
  });
}
```

Destroyed sessions are terminal. Create a fresh session instead of trying to
reuse one after `destroy()`.

## Subscribe And Unsubscribe

`subscribe()` immediately receives the current aggregate state, then future
state updates. Keep the unsubscribe function and call it when the host UI no
longer needs updates:

```ts
const unsubscribe = session.subscribe((state) => {
  status.textContent = state.status;
});

// Later, when the view unmounts:
unsubscribe();
session.destroy();
```

Calling `destroy()` also clears session listeners after the final destroyed
state has been emitted.

## Multiple Viewers

Use one session per media item. If a page shows ten images or three videos,
create one session for each viewer container. Their renderer state, detections,
prepared artifacts, and lifecycle are independent:

```ts
const sessions = await Promise.all(
  mediaItems.map((media, index) =>
    createMediaSession({
      container: containers[index],
      media,
      renderer: { autoPlay: false },
    }),
  ),
);

function closeAll() {
  for (const session of sessions) {
    session.destroy();
  }
}
```

## Appendable Detections

For uploaded media or streamed inference results, append detections only while
the session is alive:

```ts
await session.appendDetectionFrames(frames);
```

After `destroy()`, `appendDetectionFrames()` rejects with an error. That makes
late network results safe to ignore:

```ts
try {
  await session.appendDetectionFrames(frames);
} catch (error) {
  if (session.getState().status !== MediaSessionStatus.Destroyed) {
    throw error;
  }
}
```

## Recover From Errors

If media preparation or renderer startup fails, the session state reports an
error state. The app should show the error, destroy that session when the view
is done with it, and create a new session for the next media item.

```ts
const session = await createMediaSession({
  container,
  media,
  onState(state) {
    if (state.errorMessage) {
      console.error(state.errorMessage);
    }
  },
});
```

Session errors are isolated to that session. Creating a later session in the
same page starts from a clean state.
