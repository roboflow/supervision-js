---
title: Playing A Video File
group: Recipes
summary: Open a URL or uploaded Blob with the indexed video source.
---

# Playing A Video File

The indexed web video engine accepts a URL or uploaded `Blob`. It reads the
source for presentation and independently answers single-frame or thumbnail
requests, so a one-shot `ReadableStream` is not accepted; hand such a stream
to the engine directly instead. See the [browser support limits](../guides/browser-support.md)
and the [local demo](../../../CONTRIBUTING.md), runnable with `npm run dev`
from the repository checkout.

```ts
import {
  createMediaSession,
  createWebVideoEngineMediaRendererSource,
  getMediaErrorKind,
  MediaErrorKind,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";

export async function openVideo(
  container: HTMLElement,
  file: Blob | null,
  url: string,
  showUnsupported: () => void,
  showOpenError: () => void,
): Promise<(() => void) | null> {
  const media = createWebVideoEngineMediaRendererSource({
    source: file
      ? { kind: SourceKind.Blob, blob: file }
      : { kind: SourceKind.Url, url },
    display: {
      boxWidth: container.clientWidth,
      boxHeight: container.clientHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxDevicePixelRatio: 2,
    },
  });
  try {
    const session = await createMediaSession({
      container,
      media,
      renderer: { maxDevicePixelRatio: 2 },
    });
    try {
      await session.play();
    } catch (error) {
      session.destroy();
      throw error;
    }
    return () => session.destroy();
  } catch (error) {
    if (getMediaErrorKind(error) === MediaErrorKind.UnsupportedFormat)
      showUnsupported();
    else showOpenError();
    return null;
  }
}
```

Branch on stable `MediaErrorKind` values, not decoder exception text. Use the
optional `session.setDisplay()` capability to resize an existing display-box
source without recreating the session. The returned cleanup owns this session.
