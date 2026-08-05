# supervision-js

Browser-native tools for building interactive computer vision applications.

`supervision-js` provides renderer-owned media sessions, detection rendering,
styling, interaction, and editing for images, video, and browser media streams.

## Installation

```sh
npm install supervision-js
```

The package includes its internal core dependency. Consumers import the public
browser entrypoints:

```ts
import { createMediaSession } from "supervision-js";
import { createMaskBrushEditor } from "supervision-js/editing";
```

See the [project README](https://github.com/roboflow/supervision-js#readme) for
the public API, demo, and documentation links.
