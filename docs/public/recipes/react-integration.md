---
title: React Integration
group: Recipes
summary: Own a vanilla MediaSession safely from a React component.
---

# React Integration

`supervision-js` is framework-independent. A React component should own one
vanilla `MediaSession`, create it after the container mounts, and destroy it in
the effect cleanup.

```tsx
import { useEffect, useRef, useState } from "react";
import {
  BaseBoxStyle,
  BaseLabelStyle,
  annotationRenderers,
  createMediaSession,
  type DetectionFrame,
  type MediaSession,
  type MediaSessionState,
} from "supervision";

interface SupervisionViewerProps {
  readonly media: File | string;
  readonly frames: readonly DetectionFrame[];
}

export function SupervisionViewer({ media, frames }: SupervisionViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const [sessionState, setSessionState] = useState<MediaSessionState | null>(
    null,
  );

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void createMediaSession({
      container,
      media,
      detections: { frames },
      presentation: {
        renderers: [
          annotationRenderers.box({ style: new BaseBoxStyle() }),
          annotationRenderers.label({
            style: new BaseLabelStyle({ includeConfidence: true }),
          }),
        ],
      },
    })
      .then((session) => {
        if (disposed) {
          session.destroy();
          return;
        }

        sessionRef.current = session;
        unsubscribe = session.subscribe(setSessionState);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error("Unable to create supervision-js session.", error);
        }
      });

    return () => {
      disposed = true;
      unsubscribe?.();
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, [media, frames]);

  return (
    <section>
      <div
        ref={containerRef}
        style={{
          aspectRatio: "16 / 9",
          background: "#020617",
          overflow: "hidden",
          width: "100%",
        }}
      />
      <output>{sessionState?.status ?? "loading"}</output>
    </section>
  );
}
```

For video controls, keep only the session in the component and delegate media
navigation to it:

```ts
await sessionRef.current?.seek(requestedTimestamp);
await sessionRef.current?.stepForward();
sessionRef.current?.setPlaybackRate(1.25);
```

Provide `renderer.onFrame` when the host needs the canonical presented timestamp
or decoded dimensions. Do not decode video in a React hook and pass canvases
back into the renderer. If a mutable detection source changes for the current
frame, call `session.refresh()`; that is semantic invalidation, while the
session remains responsible for media retention and redraw ordering.

Keep `frames` referentially stable when its contents have not changed; otherwise
the effect correctly treats it as a new input and rebuilds the session. For
streaming inference, create the session with `detections.appendable` and append
new batches through `sessionRef.current` instead of rebuilding the session for
each result.

Do not put Pixi containers, textures, or the session's canvas in React state.
React owns the component lifecycle and UI; `MediaSession` owns media timing,
rendering, buffering, and its browser resources.
