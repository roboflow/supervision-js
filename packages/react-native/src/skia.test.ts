import { Skia } from "@shopify/react-native-skia";
import { describe, expect, it, vi } from "vitest";

import { KeypointMarkerShape } from "./index";

import {
  buildReactNativeSkiaMaskArtifact,
  createEmptyReactNativeSkiaPicture,
  createReactNativeSkiaMaskFrame,
  createReactNativeSkiaMaskFrameFromArtifact,
  createReactNativeSkiaVectorFrame,
  disposeReactNativeSkiaImage,
  disposeReactNativeSkiaPicture,
  swapReactNativeSkiaMaskImage,
  swapReactNativeSkiaPicture,
} from "./skia";
import type { ReactNativeLiveSerializedDetection } from "./index";

const drawCircle = vi.fn();
const drawLine = vi.fn();
const drawPath = vi.fn();
const pictureDispose = vi.fn();
const recorderDispose = vi.fn();
const finishRecordingAsPicture = vi.fn(() => ({
  dispose: pictureDispose,
}));
const pathClose = vi.fn();
const pathDispose = vi.fn();
const paintDispose = vi.fn();
const setStrokeCap = vi.fn();
const setStrokeJoin = vi.fn();
const setStrokeMiter = vi.fn();

vi.mock("@shopify/react-native-skia", () => ({
  AlphaType: { Opaque: 2 },
  ColorType: { Alpha_8: 1 },
  PaintStyle: { Fill: 0, Stroke: 1 },
  StrokeCap: { Butt: 0, Round: 1, Square: 2 },
  StrokeJoin: { Bevel: 2, Miter: 0, Round: 1 },
  Skia: {
    Color: vi.fn((color: number) => color),
    Data: {
      fromBytes: vi.fn((bytes: Uint8Array) => ({ bytes })),
    },
    Image: {
      MakeImage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    Paint: vi.fn(() => ({
      dispose: paintDispose,
      setAlphaf: vi.fn(),
      setAntiAlias: vi.fn(),
      setColor: vi.fn(),
      setPathEffect: vi.fn(),
      setStrokeCap,
      setStrokeJoin,
      setStrokeMiter,
      setStrokeWidth: vi.fn(),
      setStyle: vi.fn(),
    })),
    Path: {
      Make: vi.fn(() => ({
        close: pathClose,
        dispose: pathDispose,
        lineTo: vi.fn(),
        moveTo: vi.fn(),
      })),
    },
    PathEffect: {
      MakeDash: vi.fn(() => ({ dispose: vi.fn() })),
    },
    PictureRecorder: vi.fn(() => ({
      beginRecording: vi.fn(() => ({ drawCircle, drawLine, drawPath })),
      dispose: recorderDispose,
      finishRecordingAsPicture,
    })),
    XYWHRect: vi.fn((x: number, y: number, width: number, height: number) => ({
      height,
      width,
      x,
      y,
    })),
  },
}));

const detection: ReactNativeLiveSerializedDetection = {
  bbox: { x1: 0, x2: 2, y1: 0, y2: 2 },
  color: 0xff0000,
  label: "person",
  mask: new Uint8Array([1, 1, 1, 1]),
  maskHeight: 2,
  maskWidth: 2,
};

describe("createReactNativeSkiaMaskFrame", () => {
  it("builds artifact, image, and uniforms as one packet", () => {
    const frame = createReactNativeSkiaMaskFrame({
      detections: [detection],
      frameHeight: 2,
      frameWidth: 2,
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });

    expect(frame).not.toBeNull();
    expect(frame!.builder).toBe("js");
    expect(frame!.byteLength).toBeGreaterThan(0);
    expect(frame!.uniforms.uMediaRect).toEqual([0, 0, 2, 2]);
    expect(Skia.Image.MakeImage).toHaveBeenCalledWith(
      expect.objectContaining({ alphaType: 2, colorType: 1 }),
      expect.anything(),
      frame!.width,
    );
  });

  it("returns null when there is nothing to draw", () => {
    expect(
      createReactNativeSkiaMaskFrame({
        detections: [],
        frameHeight: 2,
        frameWidth: 2,
        mediaRect: { height: 2, width: 2, x: 0, y: 0 },
      }),
    ).toBeNull();
  });

  it("returns null when the Skia image upload fails", () => {
    vi.mocked(Skia.Image.MakeImage).mockReturnValueOnce(null);

    expect(
      createReactNativeSkiaMaskFrame({
        detections: [detection],
        frameHeight: 2,
        frameWidth: 2,
        mediaRect: { height: 2, width: 2, x: 0, y: 0 },
      }),
    ).toBeNull();
  });
});

describe("reusing one built mask artifact across frames", () => {
  const artifactOptions = {
    detections: [detection],
    frameHeight: 2,
    frameWidth: 2,
  };

  it("gives every frame its own Skia image so packets stay independently owned", () => {
    // PreparedFrameStore disposes each retired packet's image. Sharing one
    // handle across packets would let the first retirement dispose an image a
    // later packet is still drawing, which paints the media rect black.
    const build = buildReactNativeSkiaMaskArtifact(artifactOptions);
    const mediaRect = { height: 2, width: 2, x: 0, y: 0 };

    const first = createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      diagnostics: build!.diagnostics,
      mediaRect,
    });
    const second = createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      diagnostics: build!.diagnostics,
      mediaRect,
    });

    expect(first!.image).not.toBe(second!.image);
    expect(first!.uniforms).toEqual(second!.uniforms);
  });

  it("re-resolves uniforms so a moved media rect still tracks", () => {
    // Uniforms are frame-local; only the fill is cacheable. A session that
    // reused them would pin the overlay to wherever the video was when the
    // artifact was built.
    const build = buildReactNativeSkiaMaskArtifact(artifactOptions);

    const before = createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      diagnostics: build!.diagnostics,
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });
    const after = createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      diagnostics: build!.diagnostics,
      mediaRect: { height: 8, width: 6, x: 4, y: 5 },
    });

    expect(before!.uniforms.uMediaRect).toEqual([0, 0, 2, 2]);
    expect(after!.uniforms.uMediaRect).toEqual([4, 5, 6, 8]);
  });

  it("does not re-run the fill when presenting from a cached artifact", () => {
    const build = buildReactNativeSkiaMaskArtifact(artifactOptions);
    const fromBytesCalls = vi.mocked(Skia.Data.fromBytes).mock.calls.length;

    createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      // What the session reports for a reused artifact: no fill happened on
      // this frame, so the readout must not repeat the original cost.
      diagnostics: { ...build!.diagnostics, fillMs: 0 },
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });

    // One upload, and the same bytes the build already produced.
    expect(vi.mocked(Skia.Data.fromBytes).mock.calls.length).toBe(
      fromBytesCalls + 1,
    );
    expect(vi.mocked(Skia.Data.fromBytes).mock.lastCall?.[0]).toBe(
      build!.artifact.data,
    );
  });

  it("composes the two halves into the one-shot builder", () => {
    const composed = createReactNativeSkiaMaskFrame({
      ...artifactOptions,
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });
    const build = buildReactNativeSkiaMaskArtifact(artifactOptions);
    const split = createReactNativeSkiaMaskFrameFromArtifact({
      artifact: build!.artifact,
      diagnostics: build!.diagnostics,
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });

    expect(composed!.uniforms).toEqual(split!.uniforms);
    expect(composed!.builder).toBe(split!.builder);
    expect(composed!.byteLength).toBe(split!.byteLength);
  });

  it("returns null from the builder when there is nothing to fill", () => {
    expect(
      buildReactNativeSkiaMaskArtifact({
        detections: [],
        frameHeight: 2,
        frameWidth: 2,
      }),
    ).toBeNull();
  });
});

describe("disposeReactNativeSkiaImage", () => {
  it("disposes present images and tolerates absent ones", () => {
    const dispose = vi.fn();

    disposeReactNativeSkiaImage({
      dispose,
    } as unknown as Parameters<typeof disposeReactNativeSkiaImage>[0]);
    disposeReactNativeSkiaImage(null);
    disposeReactNativeSkiaImage(undefined);

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("Skia resource swap worklets", () => {
  it("disposes the retired mask inline without an imported worklet helper", () => {
    const dispose = vi.fn();
    const active = { value: { dispose: vi.fn() } };
    const retired = { value: { dispose } };
    const activeIsEmpty = { value: false };
    const next = { dispose: vi.fn() };
    const empty = { dispose: vi.fn() };

    swapReactNativeSkiaMaskImage(
      active as never,
      activeIsEmpty,
      retired as never,
      next as never,
      empty as never,
    );

    expect(dispose).toHaveBeenCalledOnce();
    expect(active.value).toBe(next);
  });

  it("disposes the retired vector picture inline", () => {
    const dispose = vi.fn();
    const active = { value: { dispose: vi.fn() } };
    const retired = { value: { dispose } };
    const activeIsEmpty = { value: false };
    const next = { dispose: vi.fn() };
    const empty = { dispose: vi.fn() };

    swapReactNativeSkiaPicture(
      active as never,
      activeIsEmpty,
      retired as never,
      next as never,
      empty as never,
    );

    expect(dispose).toHaveBeenCalledOnce();
    expect(active.value).toBe(next);
  });
});

describe("createReactNativeSkiaVectorFrame", () => {
  it("records mapped polygons, polylines, skeleton edges, and markers", () => {
    const frame = createReactNativeSkiaVectorFrame({
      frameHeight: 50,
      frameWidth: 100,
      keypoints: [
        {
          edges: [
            {
              from: { x: 0, y: 0 },
              stroke: { alpha: 1, color: 0x00ff00, width: 2 },
              to: { x: 100, y: 50 },
            },
          ],
          markers: [
            {
              fill: { alpha: 1, color: 0x00ff00 },
              index: 0,
              point: { x: 50, y: 25 },
              radius: 5,
              shape: KeypointMarkerShape.Circle,
              stroke: { alpha: 1, color: 0xffffff, width: 2 },
            },
            {
              fill: { alpha: 1, color: 0xff0000 },
              index: 1,
              point: { x: 25, y: 10 },
              radius: 4,
              shape: KeypointMarkerShape.Cross,
            },
          ],
        },
      ],
      mediaRect: { height: 100, width: 200, x: 10, y: 20 },
      polygons: [
        {
          fill: { alpha: 0.2, color: 0xff0000 },
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 50, y: 50 },
          ],
          stroke: { alpha: 1, color: 0xff0000, width: 2 },
        },
      ],
      polylines: [
        {
          points: [
            { x: 0, y: 25 },
            { x: 100, y: 25 },
          ],
          stroke: {
            alpha: 1,
            cap: "round",
            color: 0xffffff,
            dash: [4, 2],
            join: "bevel",
            miterLimit: 7,
            width: 1,
          },
        },
      ],
    });

    expect(frame).not.toBeNull();
    expect(frame).toMatchObject({
      edgeCount: 1,
      keypointCount: 1,
      markerCount: 2,
      polygonCount: 1,
      polylineCount: 1,
    });
    expect(drawPath).toHaveBeenCalledTimes(3);
    expect(drawLine).toHaveBeenCalledWith(10, 20, 210, 120, expect.anything());
    expect(drawCircle).toHaveBeenCalledWith(110, 70, 5, expect.anything());
    expect(pathClose).toHaveBeenCalledTimes(1);
    expect(Skia.PathEffect.MakeDash).toHaveBeenCalledWith([4, 2], 0);
    expect(setStrokeCap).toHaveBeenCalledWith(1);
    expect(setStrokeJoin).toHaveBeenCalledWith(2);
    expect(setStrokeMiter).toHaveBeenCalledWith(7);
    expect(finishRecordingAsPicture).toHaveBeenCalled();
    expect(recorderDispose).toHaveBeenCalled();
    expect(pathDispose).toHaveBeenCalled();
    expect(paintDispose).toHaveBeenCalled();
  });

  it("returns null for empty geometry", () => {
    expect(
      createReactNativeSkiaVectorFrame({
        frameHeight: 50,
        frameWidth: 100,
        mediaRect: { height: 100, width: 200, x: 0, y: 0 },
      }),
    ).toBeNull();
  });
});

describe("createEmptyReactNativeSkiaPicture", () => {
  it("records a valid no-op picture for nullable animated lanes", () => {
    const picture = createEmptyReactNativeSkiaPicture();

    expect(picture).toBe(finishRecordingAsPicture.mock.results.at(-1)?.value);
    expect(Skia.XYWHRect).toHaveBeenLastCalledWith(0, 0, 1, 1);
    expect(finishRecordingAsPicture).toHaveBeenCalled();
    expect(recorderDispose).toHaveBeenCalled();
  });
});

describe("disposeReactNativeSkiaPicture", () => {
  it("disposes present pictures and tolerates absent ones", () => {
    const dispose = vi.fn();

    disposeReactNativeSkiaPicture({ dispose } as unknown as Parameters<
      typeof disposeReactNativeSkiaPicture
    >[0]);
    disposeReactNativeSkiaPicture(null);
    disposeReactNativeSkiaPicture(undefined);

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
