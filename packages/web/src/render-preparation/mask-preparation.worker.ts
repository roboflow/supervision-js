import {
  compositeMaskFrame,
  createIdMaskRasterFrame,
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
    const idMaskFrame = createIdMaskRasterFrame(message.job.instructions);

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
        ],
      );
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

    if (imageBitmap) {
      workerScope.postMessage(
        {
          imageBitmap,
          key: message.job.key,
          requestId: message.requestId,
          type: MaskPreparationWorkerMessageType.Complete,
        },
        [imageBitmap],
      );
      return;
    }

    workerScope.postMessage(
      {
        imageData,
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Complete,
      },
      [imageData.data.buffer],
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
