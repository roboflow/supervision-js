# React Native Demo Design Guide

The React Native demo is the mobile counterpart of the public documentation:
calm, light, precise, and visibly experimental without looking like a debug
console. Reuse the documentation palette and its hierarchy rather than
inventing a separate visual language.

## Palette

| Role                      | Token                 | Value                 |
| ------------------------- | --------------------- | --------------------- |
| App canvas                | Violet 50             | `#f5f3ff`             |
| Surfaces                  | White                 | `#ffffff`             |
| Raised / selected surface | Violet 100            | `#ede9fe`             |
| Borders                   | Violet 100 / Gray 300 | `#ede9fe` / `#d1d5db` |
| Primary action and focus  | Violet 600            | `#7c3aed`             |
| Pressed / link            | Violet 700            | `#6d28d9`             |
| Primary text              | Gray 900              | `#111827`             |
| Supporting text           | Gray 500 / 600        | `#6b7280` / `#4b5563` |

Use semantic red, amber, and green only for safety, warnings, or readiness;
violet remains the one interaction accent.

## Surfaces and hierarchy

- The app shell is a pale violet canvas. Content is grouped into white cards
  with one-pixel soft-violet borders and 14–18px radii.
- Headers and floating live controls are translucent white cards over camera
  media, with dark text and a subtle violet border. The camera itself remains
  unstyled media; never wash it with the application background.
- Use a single large, high-contrast title and compact uppercase violet
  overlines for section labels. Supporting copy is gray, not white-on-black.
- Selected modes and primary actions use solid violet with white text.
  Inactive choices are transparent or pale-violet, never dark slabs.

## Interaction

- Touch targets are pill-shaped only for compact actions and filters. Use
  rounded rectangles for cards, menus, and status panels.
- Expose state with text and a small semantic dot; color alone is not the
  signal. Preserve tabular numerals for live measurements.
- Keep borders, spacing, and elevation quiet. A small shadow on raised cards is
  enough; avoid glow, gradients, or multiple competing accents.

## Media and privacy

- Detection masks use their semantic class colors. Privacy preview and
  redaction keep a visible mask fill plus a contour, so the protected region is
  legible before and after a class is selected.
- Safety Zone, Golden Pose, and Privacy can use their semantic status colors
  inside the media frame, while the surrounding product UI remains violet-led.
