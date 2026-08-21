import {
  compositeMaskFrame,
  createMaskIdFrame,
  createPngIdMaskFrame,
  createRegionMaskCoverageFrame,
} from "#render-preparation/mask-frame-compositor";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import {
  MaskPreparationWorkerMessageType,
  type MaskPreparationWorkerRequest,
  type MaskPreparationWorkerResponse,
} from "#render-preparation/mask-preparation-worker-protocol";

type MaskPreparationWorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MaskPreparationWorkerRequest>) => void,
  ): void;
  postMessage(message: MaskPreparationWorkerResponse): void;
  postMessage(
    message: MaskPreparationWorkerResponse,
    transfer: Transferable[],
  ): void;
};

const workerScope = globalThis as unknown as MaskPreparationWorkerScope;

workerScope.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type !== MaskPreparationWorkerMessageType.Prepare) {
    return;
  }

  void prepareMaskFrame(message);
});

async function prepareMaskFrame(message: MaskPreparationWorkerRequest) {
  try {
    const regionMaskCoverage = createRegionMaskCoverageFrame(
      message.job.instructions,
    );
    const pngIdMaskFrame = await createPngIdMaskWorkerResponse(
      message,
      regionMaskCoverage,
    );

    if (pngIdMaskFrame) {
      workerScope.postMessage(pngIdMaskFrame, [
        pngIdMaskFrame.imageBitmap,
        pngIdMaskFrame.png.buffer,
        pngIdMaskFrame.fillPalette.buffer,
        pngIdMaskFrame.strokePalette.buffer,
        pngIdMaskFrame.strokeWidths.buffer,
        ...getRegionMaskCoverageTransfers(regionMaskCoverage),
      ]);
      return;
    }

    const compositedFrame = compositeMaskFrame(message.job.instructions);

    if (!compositedFrame) {
      workerScope.postMessage({
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Empty,
      });
      return;
    }

    const imageData = new ImageData(
      compositedFrame.data,
      compositedFrame.width,
      compositedFrame.height,
    );
    const imageBitmap = createImageBitmapFromImageData(imageData);
    const idMaskData = createMaskIdFrame(message.job.instructions)?.data;

    if (imageBitmap) {
      workerScope.postMessage(
        {
          imageBitmap,
          idMaskData,
          key: message.job.key,
          regionMaskCoverage,
          requestId: message.requestId,
          type: MaskPreparationWorkerMessageType.Complete,
        },
        [
          ...(idMaskData ? [idMaskData.buffer] : []),
          ...getRegionMaskCoverageTransfers(regionMaskCoverage),
          imageBitmap,
        ],
      );
      return;
    }

    workerScope.postMessage(
      {
        idMaskData,
        imageData,
        key: message.job.key,
        regionMaskCoverage,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Complete,
      },
      [
        ...(idMaskData ? [idMaskData.buffer] : []),
        ...getRegionMaskCoverageTransfers(regionMaskCoverage),
        imageData.data.buffer,
      ],
    );
  } catch (error) {
    workerScope.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "Unable to prepare mask frame.",
      key: message.job.key,
      requestId: message.requestId,
      type: MaskPreparationWorkerMessageType.Error,
    });
  }
}

async function createPngIdMaskWorkerResponse(
  message: MaskPreparationWorkerRequest,
  regionMaskCoverage: ReturnType<typeof createRegionMaskCoverageFrame>,
): Promise<
  | (MaskPreparationWorkerResponse & {
      readonly fillPalette: Float32Array<ArrayBuffer>;
      readonly imageBitmap: ImageBitmap;
      readonly maxStrokeWidth: number;
      readonly png: Uint8Array<ArrayBuffer>;
      readonly strokePalette: Float32Array<ArrayBuffer>;
      readonly strokeWidths: Float32Array<ArrayBuffer>;
    })
  | undefined
> {
  if (
    typeof Blob === "undefined" ||
    typeof createImageBitmap === "undefined" ||
    typeof CompressionStream === "undefined"
  ) {
    return undefined;
  }

  let frame: Awaited<ReturnType<typeof createPngIdMaskFrame>>;

  try {
    frame = await createPngIdMaskFrame(message.job.instructions);
  } catch {
    return undefined;
  }

  if (!frame) {
    return undefined;
  }

  let imageBitmap: ImageBitmap;

  try {
    imageBitmap = await createImageBitmap(
      new Blob([frame.png], { type: "image/png" }),
    );
  } catch {
    return undefined;
  }

  return {
    artifactKind: PreparedMaskFrameKind.PngIdMask,
    fillPalette: frame.fillPalette,
    hasStroke: frame.hasStroke,
    imageBitmap,
    key: message.job.key,
    maxStrokeWidth: frame.maxStrokeWidth,
    png: frame.png,
    requestId: message.requestId,
    regionMaskCoverage,
    strokePalette: frame.strokePalette,
    strokeWidths: frame.strokeWidths,
    type: MaskPreparationWorkerMessageType.Complete,
  };
}

function getRegionMaskCoverageTransfers(
  coverage: ReturnType<typeof createRegionMaskCoverageFrame>,
) {
  return coverage?.entries.map(({ data }) => data.buffer) ?? [];
}

function createImageBitmapFromImageData(imageData: ImageData) {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }

  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.putImageData(imageData, 0, 0);

  return canvas.transferToImageBitmap();
}
