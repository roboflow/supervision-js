---
title: Showing Playback State
group: Recipes
summary: Display presented time and loading state from one session subscription.
---

# Showing Playback State

Subscribe to state and dispose only the subscription when the session is owned
elsewhere. `presentedTime` identifies the pixels on screen. The generic
`source.awaitingRead` activity is independent of current-target fetching; it
does not prove that a requested time is being decoded. The
`renderPreparationGateAbandoned` flag is separate.

```ts
import type { MediaSession } from "supervision";

export function installPlaybackState(
  session: MediaSession,
  displayedTime: HTMLOutputElement,
  playbackStatus: HTMLElement,
): () => void {
  const unsubscribe = session.subscribe((state) => {
    const renderer = state.renderer;
    displayedTime.value =
      renderer?.presentedTime == null
        ? "No frame"
        : `${renderer.presentedTime.toFixed(3)} s`;
    playbackStatus.textContent = renderer?.scrubbing
      ? "Scrubbing"
      : renderer?.seeking
        ? "Seeking"
        : state.status;
    if (renderer?.source.awaitingRead) {
      playbackStatus.textContent += " · Reading media";
    }
    if (renderer?.renderPreparationGateAbandoned) {
      playbackStatus.textContent += " · Preparation wait expired";
    }
  });
  return unsubscribe;
}
```

Do not read a separate media-element clock or infer displayed identity from a
seek request. The session owner remains responsible for `session.destroy()`.
