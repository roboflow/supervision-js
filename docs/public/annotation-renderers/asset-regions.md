---
title: Asset Regions
summary: Place image assets over detection bounds or keypoint anchors.
---

# Asset Regions

The region annotation renderer places a browser-loadable image over a region
owned by a semantic detection. It is useful for static icons, badges, logos,
animated GIFs, and other assets that should follow objects across playback
without exposing a Pixi texture, animation source, or display object to
application code.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=regions"
    loading="lazy"
    title="Interactive asset region annotation renderer playground"
  ></iframe>
</div>

The playground uses the frozen basketball fixture's real COCO pose keypoints.
Switch between class-specific SVG team badges and a looping fire GIF, then tune
the shared scale, offset, and rotation controls. Both examples are loaded by
the browser renderer and anchored to visible face keypoints.

## Add static icon regions

Give each independently targeted asset a stable renderer id. This example
maps two SVG badge URLs to the matching player classes while sharing the same
semantic head anchor and transform:

```ts
const teamBadges = [
  ["white-team-badge", "white team player", whiteBadgeUrl],
  ["yellow-team-badge", "yellow team player", yellowBadgeUrl],
] as const;

session.setPresentation({
  renderers: teamBadges.map(([id, className, src]) =>
    annotationRenderers.region({
      id,
      target: { className },
      source: { kind: "asset", asset: { src } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      transform: {
        scale: 0.95,
        offset: { x: 0, y: -1.05 },
        rotation: 0,
      },
      compose: { mode: "over" },
    }),
  ),
});
```

## Add an animated asset region

```ts
const fireGifUrl = new URL("./fire.gif", import.meta.url).href;

session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "player-fire",
      target: {
        className: ["white team player", "yellow team player"],
      },
      source: { kind: "asset", asset: { src: fireGifUrl } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      transform: {
        scale: 1.35,
        offset: { x: 0, y: -0.58 },
        rotation: 0,
      },
      compose: { mode: "over" },
    }),
  ],
});
```

Targets can match a detection `id`, `className`, `sourceId`, a custom resolver,
or any combination of those fields. `bounds` uses the complete detection
rectangle. A numeric keypoint anchor addresses one keypoint index; the `head`
anchor uses visible COCO face points 0 through 4 and falls back to the top of
the detection rectangle.

`scale` is uniform. Offsets are relative to the resolved region, rotation is in
radians, and `compose.zIndex` orders multiple region renderer instances. The
asset must be fetchable by the browser under the host application's normal URL
and CORS policy. Static browser image formats render as sprites. GIF files loop
automatically while preserving the same URL-based public API.
Asset failures omit that renderer instance without stopping playback and are
reported through `renderer.diagnostics.onAssetError` when configured. Replacing
the descriptor with a new asset source retries loading.

This first region source draws an asset **over** media. Cropping the current
media frame for effects such as an enlarged head, or covering a mask before
drawing a replacement asset, requires the later media-source and replacement
coverage capabilities; an asset overlay does not claim to erase the original
pixels.
