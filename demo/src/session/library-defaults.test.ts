import {
  MediaInteractionMode,
  MediaRendererFit,
  MediaSessionMode,
  RenderPreparationMode,
  type MediaSessionDetectionOptions,
  type MediaSessionRendererOptions,
} from "supervision";
import { describe, expect, it } from "vitest";

import {
  DemoOptionOrigin,
  listDemoLibraryDepartures,
  readDemoLibraryDefaults,
  readDemoOptionOrigin,
} from "./library-defaults";
import {
  DemoEngineSource,
  DemoMediaPath,
  optionSupported,
  resolveDemoSessionConfiguration,
} from "./session-options";

const detections: MediaSessionDetectionOptions = {
  frames: [],
  sync: { frameRate: 24 },
};

const renderer: MediaSessionRendererOptions = {
  fit: MediaRendererFit.Contain,
  interaction: { mode: MediaInteractionMode.PausedOnly },
  loop: true,
};

function configurationWith(options: {
  readonly detections?: MediaSessionDetectionOptions;
  readonly mediaPath?: DemoMediaPath;
  readonly playbackGate?: boolean;
  readonly renderer?: MediaSessionRendererOptions;
}) {
  return resolveDemoSessionConfiguration({
    detections: options.detections ?? detections,
    engine: {},
    engineSource: DemoEngineSource.None,
    mediaPath: options.mediaPath ?? DemoMediaPath.Mediabunny,
    mediaPathSupport: optionSupported,
    mode: MediaSessionMode.File,
    normalizationSupport: optionSupported,
    playbackGate: options.playbackGate,
    renderer: options.renderer ?? renderer,
  });
}

describe("the library baseline", () => {
  it("reads the numbers the library picks for a clip at this frame rate", () => {
    const library = readDemoLibraryDefaults(configurationWith({}));

    expect(library.detectionBuffer.bufferBehindSeconds).toBe(5);
    expect(library.renderPreparation.maskFrame?.prefetchFrameCount).toBe(
      7 * 24,
    );
    expect(library.renderPreparation.playbackGate?.enabled).toBe(true);
  });

  it("leaves the annotation gate absent, because a host asking for nothing gets none", () => {
    const library = readDemoLibraryDefaults(configurationWith({}));

    expect(library.detectionBuffer.playbackGate).toBeUndefined();
  });

  it("moves with the clip's own frame rate rather than restating a figure", () => {
    const slower = readDemoLibraryDefaults(
      configurationWith({
        detections: { frames: [], sync: { frameRate: 12 } },
      }),
    );

    expect(slower.renderPreparation.maskFrame?.prefetchFrameCount).toBe(7 * 12);
  });
});

describe("where a value came from", () => {
  it("reads a value the library would pick as the library's, whoever set it", () => {
    expect(readDemoOptionOrigin(undefined, 10, 10)).toBe(
      DemoOptionOrigin.Library,
    );
    expect(readDemoOptionOrigin(10, 10, 10)).toBe(DemoOptionOrigin.Library);
  });

  it("tells a workbench departure from one the visitor made", () => {
    expect(readDemoOptionOrigin(undefined, 10, 0.5)).toBe(
      DemoOptionOrigin.Workbench,
    );
    expect(readDemoOptionOrigin(10, 10, 0.5)).toBe(DemoOptionOrigin.Panel);
  });
});

describe("what differs from the library", () => {
  const listFor = (
    configuration: ReturnType<typeof configurationWith>,
    search = "",
  ) =>
    listDemoLibraryDepartures({
      configuration,
      renderQuality: undefined,
      search,
    }).map((departure) => departure.setting);

  it("names the media path only while the engine is the one reading the clip", () => {
    expect(listFor(configurationWith({}))).not.toContain("Media path");
    expect(
      listFor(configurationWith({ mediaPath: DemoMediaPath.Engine })),
    ).toContain("Media path");
  });

  it("names a gate the workbench pinned on", () => {
    expect(listFor(configurationWith({ playbackGate: true }))).toContain(
      "Waits for annotations",
    );
    expect(listFor(configurationWith({}))).not.toContain(
      "Waits for annotations",
    );
  });

  it("names a mask raster the workbench sized itself", () => {
    const sized = configurationWith({
      renderer: {
        ...renderer,
        renderPreparation: {
          maskFrame: {
            display: {
              boxHeight: 100,
              boxWidth: 200,
              devicePixelRatio: 2,
            },
          },
        },
      },
    });

    expect(listFor(sized)).toContain("Mask raster size");
    expect(listFor(configurationWith({}))).not.toContain("Mask raster size");
  });

  it("names a preparation mode the workbench pinned rather than resolved", () => {
    expect(
      listFor(
        configurationWith({
          renderer: {
            ...renderer,
            renderPreparation: { mode: RenderPreparationMode.Worker },
          },
        }),
      ),
    ).toContain("Render preparation mode");
    expect(listFor(configurationWith({}))).not.toContain(
      "Render preparation mode",
    );
  });

  it("drops the decode resolution once the page URL asks for the engine's own", () => {
    const engine = configurationWith({ mediaPath: DemoMediaPath.Engine });

    expect(listFor(engine)).toContain("Decode resolution");
    expect(listFor(engine, "?decode=native")).not.toContain(
      "Decode resolution",
    );
  });

  it("says what the library would do for every departure it names", () => {
    const departures = listDemoLibraryDepartures({
      configuration: configurationWith({ mediaPath: DemoMediaPath.Engine }),
      renderQuality: 1.5,
      search: "",
    });

    expect(departures.length).toBeGreaterThan(0);
    expect(
      departures.filter(
        (departure) =>
          departure.library.length === 0 ||
          departure.why.length === 0 ||
          departure.value.length === 0,
      ),
    ).toEqual([]);
  });
});
