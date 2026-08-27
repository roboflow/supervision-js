---
title: Regions
summary: Place media crops or image assets over detection-owned regions.
---

# Regions

The region annotation renderer places a crop of the current media frame or a
browser-loadable image over a region owned by a semantic detection. It supports
bounded media effects alongside static icons, badges, logos, and animated GIFs.
Application code never receives a Pixi texture, animation source, filter, or
display object.

<div class="supervision-layer-playground">
  <iframe
    data-supervision-playground-src="demo/?embed=annotation-renderer&amp;renderer=regions"
    loading="lazy"
    title="Interactive region annotation renderer playground"
  ></iframe>
</div>

The playground uses frozen, direct SAM3 `head` masks associated offline with
the basketball fixture's team-player detections. It opens with transparent
player-head crops enlarged over the original frame; no rectangular background
patch, synthetic head window, or runtime keypoint is used for that mode.
Switch to class-specific SVG team badges or a looping fire GIF, then tune the
head scale or fixed screen-pixel asset size, offset, rotation, and media-crop
mirror controls.

## Add visual effects

Use [Region effects](./region-effects.md) to blur or pixelate an exact semantic
region of the current media frame. That focused page also contrasts those
bounded media effects with the existing focus/spotlight composition, using one
interactive privacy fixture and live code snippet.

## Enlarge a region from the current media frame

Use a `media` source to crop pixels from the same frame the renderer is already
presenting. The source and destination regions are resolved independently from
the same detection. This example targets dedicated `head` detections and clips
the sampled pixels to their exact SAM3 masks:

```ts
session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "player-big-heads",
      target: {
        className: "head",
        sourceId: "sam3-head",
      },
      source: {
        kind: "media",
        region: { kind: "bounds" },
        coverage: { kind: "mask" },
      },
      region: { kind: "bounds" },
      transform: {
        scale: 2.5,
        offset: { x: 0, y: 0 },
        rotation: 0,
      },
      compose: { mode: "over" },
    }),
  ],
});
```

The browser backend implements this as a dynamic subtexture of the
renderer-owned media texture plus the already-prepared GPU ID-mask artifact. It
does not decode RLE masks on the playback path, decode the video again, copy the
composited canvas, or read the frame back through the CPU. The source crop is
clipped to the media bounds and its exact semantic mask; both update with the
active detection frame across playback, seek, and loop. A media source that
requests mask coverage is omitted for detections without a usable mask instead
of falling back to a visible rectangle. Polygon coverage remains available for
detections whose canonical geometry is a closed polygon.

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
        size: { width: 44, space: "screen" },
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
        size: { width: 52, space: "screen" },
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

`scale` is uniform and relative to the resolved detection region. Use
`size: { width, height?, space: "screen" }` when every asset should keep the
same visible pixel dimensions regardless of detection size or viewport zoom;
omitting `height` preserves the asset aspect ratio. Media-space size is also
available through `space: "media"`. `size` and `scale` are intentionally
mutually exclusive. Offsets are relative to the resolved region, rotation is in
radians, `flip.horizontal` and `flip.vertical` mirror around the destination
anchor, and `compose.zIndex` orders multiple region renderer instances. The
asset must be fetchable by the browser under the host application's normal URL
and CORS policy. Static browser image formats render as sprites. GIF files loop
automatically while preserving the same URL-based public API.
Asset failures omit that renderer instance without stopping playback and are
reported through `renderer.diagnostics.onAssetError` when configured. Replacing
the descriptor with a new asset source retries loading.

Both media crops and assets currently compose **over** the media. Covering a
mask before drawing a replacement asset requires the later replacement-coverage
capability; an overlay does not claim to erase the original pixels.
