# People Privacy Effects

A three-second, person-only privacy fixture derived from the committed `horse_trail` SAM3 fixture. The scene shows a rider; it is named for the privacy use case rather than claiming people are walking.

## Provenance

- Source fixture: [horse_trail](../horse_trail/README.md)
- Source model and prompt: `sam3/sam3_final` with `person`
- Frame range: 0 through 89 of the source fixture's normalized 30fps timeline
- Media: first three seconds of the committed source video, re-encoded as 30fps VP9 WebM with audio removed
- Detection data: the committed SAM3 frames filtered to `className: "person"`; masks and center-based rectangles are preserved without synthetic geometry

Regenerate this fixture after changing the source fixture with:

```sh
node tools/fixture-derivation/create-people-privacy-fixture.mjs
```

The fixture is used by the Regions documentation playground for blur, pixelate, and the existing focus/spotlight composition. It never calls inference at runtime.
