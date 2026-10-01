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

/**
 * CSS colours of a depth colormap at `stops` evenly spaced points, far end
 * first and near end last, read from the same table the depth renderer draws
 * with. A legend that matches the picture is
 * `linear-gradient(to right, ${colors.join(", ")})`.
 */
export function depthColormapColors(
  colormap: DepthColormap,
  stops = 16,
): string[] {
  if (!Number.isInteger(stops) || stops < 2 || stops > DEPTH_COLORMAP_ENTRIES) {
    throw new RangeError(
      `Depth colormap stops must be an integer from 2 to ${DEPTH_COLORMAP_ENTRIES}, got ${stops}.`,
    );
  }

  const lut = createDepthColormapLut(colormap);

  return Array.from({ length: stops }, (_, stop) => {
    const offset =
      Math.round((stop * (DEPTH_COLORMAP_ENTRIES - 1)) / (stops - 1)) * 4;

    return `#${Array.from(lut.subarray(offset, offset + 3), (channel) =>
      channel.toString(16).padStart(2, "0"),
    ).join("")}`;
  });
}
