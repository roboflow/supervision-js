import { DepthColormap } from "#types/depth-map";
import {
  cividisTable,
  infernoTable,
  magmaTable,
  turboTable,
  viridisTable,
} from "#utils/depth-colormap-tables";

/** Entries in every depth colour table; the colour coordinate t picks one. */
export const DEPTH_COLORMAP_ENTRIES = 256;

/**
 * Published tables rather than polynomial fits: a fit of Turbo misses its dark
 * ends by more than a colour step, which is where depth edges sit.
 */
const colormapTables: Readonly<
  Record<Exclude<DepthColormap, "grayscale">, string>
> = {
  cividis: cividisTable,
  inferno: infernoTable,
  magma: magmaTable,
  turbo: turboTable,
  viridis: viridisTable,
};

const depthColormaps: ReadonlySet<string> = new Set(
  Object.values(DepthColormap),
);

export function isDepthColormap(value: unknown): value is DepthColormap {
  return typeof value === "string" && depthColormaps.has(value);
}

/**
 * The colour table as 256 RGBA8 entries with opaque alpha, far or low values
 * first. Entry `i` is the colour of `t = i / 255`.
 */
export function createDepthColormapLut(name: DepthColormap): Uint8Array {
  if (!isDepthColormap(name)) {
    throw new RangeError(`Unknown depth colormap "${String(name)}".`);
  }

  const lut = new Uint8Array(DEPTH_COLORMAP_ENTRIES * 4);

  for (let index = 0; index < DEPTH_COLORMAP_ENTRIES; index += 1) {
    const offset = index * 4;

    if (name === DepthColormap.Grayscale) {
      lut[offset] = index;
      lut[offset + 1] = index;
      lut[offset + 2] = index;
    } else {
      const table = colormapTables[name];
      const hex = index * 6;

      lut[offset] = Number.parseInt(table.slice(hex, hex + 2), 16);
      lut[offset + 1] = Number.parseInt(table.slice(hex + 2, hex + 4), 16);
      lut[offset + 2] = Number.parseInt(table.slice(hex + 4, hex + 6), 16);
    }
    lut[offset + 3] = 255;
  }

  return lut;
}
