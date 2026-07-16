import { Skia } from "@shopify/react-native-skia";
import { describe, expect, it, vi } from "vitest";

import { KeypointMarkerShape } from "./index";

import {
  createReactNativeSkiaMaskFrame,
  createReactNativeSkiaVectorFrame,
  disposeReactNativeSkiaImage,
  disposeReactNativeSkiaPicture,
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

vi.mock("@shopify/react-native-skia", () => ({
  AlphaType: { Opaque: 2 },
  ColorType: { Alpha_8: 1 },
  PaintStyle: { Fill: 0, Stroke: 1 },
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
            color: 0xffffff,
            dash: [4, 2],
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
