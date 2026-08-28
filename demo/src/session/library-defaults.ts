import {
  RenderPreparationMode,
  resolveMediaSessionDefaults,
  type ResolvedMediaSessionDefaults,
} from "supervision";

import {
  formatOptionCount,
  formatOptionFlag,
  formatOptionSeconds,
} from "./option-format";
import { formatDemoRenderQualityValue } from "./render-quality";
import type { DemoRenderQuality } from "./render-quality";
import {
  DemoMediaPath,
  type DemoSessionConfiguration,
} from "./session-options";

/** Every value a control can sit at, for the comparison against the library. */
export type DemoOptionValue = string | number | boolean | undefined;

/** Where the value a control is showing came from. */
export enum DemoOptionOrigin {
  /** What the library resolves when a host supplies nothing. */
  Library = "library",
  /** The workbench asked for something else when it opened the clip. */
  Workbench = "workbench",
  /** Moved from this panel, on top of whatever opened the clip. */
  Panel = "panel",
}

export const demoOptionOriginLabels: Record<DemoOptionOrigin, string> = {
  [DemoOptionOrigin.Library]: "library default",
  [DemoOptionOrigin.Panel]: "changed",
  [DemoOptionOrigin.Workbench]: "workbench",
};

/**
 * What the library resolves for this clip when a host supplies nothing.
 *
 * Only the mode and the clip's annotation frame rate are handed over, because
 * both change what the library picks for itself: File and Stream carry
 * different buffers, and the mask window counts are seconds converted at that
 * rate. Everything else is left out, so what comes back is the baseline every
 * control is measured against.
 */
export function readDemoLibraryDefaults(
  configuration: DemoSessionConfiguration,
): ResolvedMediaSessionDefaults {
  return resolveMediaSessionDefaults({
    detections: {
      frames: [],
      sync: { frameRate: configuration.resolved.detectionBuffer.frameRate },
    },
    mode: configuration.mode,
  });
}

/**
 * A value equal to the library's own is at the library default whoever put it
 * there, so a setting a visitor returns by hand reads as returned.
 */
export function readDemoOptionOrigin(
  explicit: DemoOptionValue,
  current: DemoOptionValue,
  libraryDefault: DemoOptionValue,
): DemoOptionOrigin {
  if (current === libraryDefault) {
    return DemoOptionOrigin.Library;
  }

  return explicit === undefined
    ? DemoOptionOrigin.Workbench
    : DemoOptionOrigin.Panel;
}

/** One thing this session does that a bare `createMediaSession` would not. */
export interface DemoLibraryDeparture {
  /** What the library would do, said as a value. */
  readonly library: string;
  /** The control or option this is. */
  readonly setting: string;
  /** What this session is running instead. */
  readonly value: string;
  /** Why the workbench departs. */
  readonly why: string;
}

const NATIVE_OVERRIDE = "native";

/**
 * Everything this session runs that the library would not, read off the open
 * session, so a departure the visitor returns by hand leaves this list on its
 * own.
 */
export function listDemoLibraryDepartures(options: {
  readonly configuration: DemoSessionConfiguration;
  readonly renderQuality: DemoRenderQuality;
  readonly search: string;
}): readonly DemoLibraryDeparture[] {
  const { configuration, renderQuality, search } = options;
  const library = readDemoLibraryDefaults(configuration);
  const buffer = configuration.resolved.detectionBuffer;
  const libraryBuffer = library.detectionBuffer;
  const maskFrame = configuration.resolved.renderPreparation.maskFrame;
  const libraryMaskFrame = library.renderPreparation.maskFrame;
  const detectionGate = buffer.playbackGate;
  const libraryDetectionGate = libraryBuffer.playbackGate;
  const preparationGate = configuration.resolved.renderPreparation.playbackGate;
  const libraryPreparationGate = library.renderPreparation.playbackGate;
  const departures: DemoLibraryDeparture[] = [];

  if (configuration.mediaPath === DemoMediaPath.Engine) {
    departures.push({
      library: "Mediabunny, the reader the library ships with",
      setting: "Media path",
      value: "Web video engine",
      why: "The web video engine is a separate package. A project that installs only `supervision` reads the clip through Mediabunny.",
    });
  }

  compare(departures, {
    library: formatOptionFlag(libraryDetectionGate?.enabled),
    setting: "Waits for annotations",
    value: formatOptionFlag(detectionGate?.enabled),
    why: "A sample ships its annotations with it, so nothing is normally waited for.",
  });
  compare(departures, {
    library: formatOptionSeconds(libraryDetectionGate?.requiredAheadSeconds),
    setting: "Annotations required ahead",
    value: formatOptionSeconds(detectionGate?.requiredAheadSeconds),
    why: "How much annotation has to be loaded before the picture may move.",
  });
  compare(departures, {
    library: formatOptionFlag(libraryPreparationGate?.enabled),
    setting: "Waits for masks",
    value: formatOptionFlag(preparationGate?.enabled),
    why: "Whether the picture is held until the frame's masks have been drawn.",
  });
  compare(departures, {
    library: formatOptionSeconds(libraryBuffer.bufferAheadSeconds),
    setting: "Buffer ahead",
    value: formatOptionSeconds(buffer.bufferAheadSeconds),
    why: "Seconds of annotation held in front of the playhead.",
  });
  compare(departures, {
    library: formatOptionSeconds(libraryBuffer.bufferBehindSeconds),
    setting: "Buffer behind",
    value: formatOptionSeconds(buffer.bufferBehindSeconds),
    why: "This workbench is scrubbed backwards as often as forwards, and the library's file default holds twenty times more ahead of the playhead than behind it. Matching the two directions stops annotations blinking out during a backward drag.",
  });
  compare(departures, {
    library: formatOptionSeconds(libraryBuffer.refreshIntervalSeconds),
    setting: "Refresh interval",
    value: formatOptionSeconds(buffer.refreshIntervalSeconds),
    why: "How often annotations already loaded are read again.",
  });
  compare(departures, {
    library: formatOptionCount(libraryMaskFrame?.prefetchFrameCount),
    setting: "Mask prefetch frames",
    value: formatOptionCount(maskFrame?.prefetchFrameCount),
    why: "How many frames of masks are kept drawn ahead of the picture.",
  });
  compare(departures, {
    library: formatOptionCount(libraryMaskFrame?.maxCacheFrameCount),
    setting: "Mask cache frames",
    value: formatOptionCount(maskFrame?.maxCacheFrameCount),
    why: "How many drawn masks are held before the oldest are dropped.",
  });
  compare(departures, {
    library: formatOptionCount(libraryMaskFrame?.workerCount),
    setting: "Mask worker count",
    value: formatOptionCount(maskFrame?.workerCount),
    why: "How many masks may be turned into pixels at once.",
  });

  if (maskFrame?.display !== undefined) {
    departures.push({
      library: "cooked at the size the detection recorded",
      setting: "Mask raster size",
      value: "cooked at the size the picture is shown",
      why: "A mask raster holds a detection id per pixel, so it can only be sampled nearest. Cooked larger than the box it is drawn into it discards whole texels rather than averaging them, which ragged the edges and made them crawl during playback.",
    });
  }

  if (configuration.preparationMode !== RenderPreparationMode.Auto) {
    departures.push({
      library: "Auto, which takes Worker wherever workers exist",
      setting: "Render preparation mode",
      value: configuration.preparationMode,
      why: "Pinned rather than resolved.",
    });
  }

  if (!configuration.autoPlay) {
    departures.push({
      library: "on",
      setting: "Auto play",
      value: "off",
      why: "The workbench starts the clip itself after every reopen, so that the playhead it restores is the one that plays.",
    });
  }

  if (renderQuality !== undefined) {
    departures.push({
      library:
        "none, so the canvas follows the viewer's own device pixel ratio",
      setting: "Max device pixel ratio",
      value: formatDemoRenderQualityValue(renderQuality),
      why: "A ceiling keeps the picture comparable between a laptop and a phone, and is what the Quality control moves. No limit returns it to the library's own answer.",
    });
  }

  if (
    configuration.mediaPath === DemoMediaPath.Engine &&
    new URLSearchParams(search).get("decode") !== NATIVE_OVERRIDE
  ) {
    departures.push({
      library: "decoded at the clip's own resolution",
      setting: "Decode resolution",
      value: "decoded at the size the picture is shown",
      why: "The workbench runs the engine without a canvas of its own, so it has no display box to measure. A phone-shaped clip in a laptop-shaped stage would otherwise decode several times the pixels that reach the screen. `?decode=native` returns one page load to the engine's own default.",
    });
  }

  if (typeof buffer.enabled === "function") {
    departures.push({
      library: "always loading",
      setting: "Annotation loading",
      value: "loads only while a layer draws annotations",
      why: "Turning every layer off in the Style tab stops fetching as well as drawing, so the layers can be measured against each other. The window already held stays loaded.",
    });
  }

  return departures;
}

function compare(
  departures: DemoLibraryDeparture[],
  departure: DemoLibraryDeparture,
) {
  if (departure.value !== departure.library) {
    departures.push(departure);
  }
}
