import {
  compositeMaskFrame,
  createIdMaskRasterFrame,
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

  prepareMaskFrame(message);
});

function prepareMaskFrame(message: MaskPreparationWorkerRequest) {
  try {
    const regionMaskCoverage = createRegionMaskCoverageFrame(
      message.job.instructions,
    );
    const coverageTransfers =
      getRegionMaskCoverageTransfers(regionMaskCoverage);
    const idMaskFrame = createIdMaskRasterFrame(
      message.job.instructions,
      message.job.maxRasterWidth,
    );

    if (idMaskFrame) {
      workerScope.postMessage(
        {
          artifactKind: PreparedMaskFrameKind.IdMask,
          fillPalette: idMaskFrame.fillPalette,
          hasStroke: idMaskFrame.hasStroke,
          height: idMaskFrame.height,
          key: message.job.key,
          maxStrokeWidth: idMaskFrame.maxStrokeWidth,
          raster: idMaskFrame.data,
          regionMaskCoverage,
          requestId: message.requestId,
          strokePalette: idMaskFrame.strokePalette,
          strokeWidths: idMaskFrame.strokeWidths,
          type: MaskPreparationWorkerMessageType.Complete,
          width: idMaskFrame.width,
        },
        [
          idMaskFrame.data.buffer,
          idMaskFrame.fillPalette.buffer,
          idMaskFrame.strokePalette.buffer,
          idMaskFrame.strokeWidths.buffer,
          ...coverageTransfers,
        ],
      );
      return;
    }

    const compositedFrame = compositeMaskFrame(message.job.instructions);

    if (!compositedFrame && !regionMaskCoverage) {
      workerScope.postMessage({
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Empty,
      });
      return;
    }

    const preparedPixels =
      compositedFrame ?? createTransparentCoverageCarrier();
    const imageData = new ImageData(
      preparedPixels.data,
      preparedPixels.width,
      preparedPixels.height,
    );
    const imageBitmap = createImageBitmapFromImageData(imageData);
    // The halo lays this plane into a canvas sized from the composite, so a
    // raster width of its own would shear every row.
    const idMaskData = createIdMaskRasterFrame(message.job.instructions)?.data;
    const idMaskTransfers = idMaskData ? [idMaskData.buffer] : [];

    if (imageBitmap) {
      workerScope.postMessage(
        {
          idMaskData,
          imageBitmap,
          key: message.job.key,
          regionMaskCoverage,
          requestId: message.requestId,
          type: MaskPreparationWorkerMessageType.Complete,
        },
        [imageBitmap, ...idMaskTransfers, ...coverageTransfers],
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
      [imageData.data.buffer, ...idMaskTransfers, ...coverageTransfers],
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

/**
 * A frame that carries only region coverage has nothing to composite, and the
 * RGBA branch still has to produce an artifact for the coverage to ride on.
 */
function createTransparentCoverageCarrier() {
  return {
    data: new Uint8ClampedArray(new ArrayBuffer(4)),
    height: 1,
    width: 1,
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
