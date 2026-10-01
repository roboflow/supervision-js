import {
  compositeMaskFrame,
  createIdMaskPlane,
  createIdMaskRasterFrame,
  createRegionMaskCoverageFrame,
} from "#render-preparation/mask-frame-compositor";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import { colorizeHeatmap } from "#renderers/heatmap-color";
import {
  HeatmapPreparationWorkerMessageType,
  type HeatmapPreparationWorkerRequest,
  type HeatmapPreparationWorkerResponse,
} from "#render-preparation/heatmap-preparation-worker-protocol";
import {
  MaskPreparationWorkerMessageType,
  type MaskPreparationWorkerRequest,
  type MaskPreparationWorkerResponse,
} from "#render-preparation/mask-preparation-worker-protocol";
import {
  DepthPreparationWorkerMessageType,
  type DepthPreparationWorkerRequest,
  type DepthPreparationWorkerResponse,
  type DepthPreviewLumaWorkerRequest,
  type DepthPreviewLumaWorkerResponse,
} from "#render-preparation/depth-preparation-worker-protocol";
import { decodeDepthPreparationRequest } from "#render-preparation/depth-frame-decode";
import {
  readVideoFrameLuma,
  type DepthPreviewLumaScratch,
} from "#render-preparation/depth-preview-luma";

type PreparationWorkerResponse =
  | MaskPreparationWorkerResponse
  | HeatmapPreparationWorkerResponse
  | DepthPreparationWorkerResponse
  | DepthPreviewLumaWorkerResponse;

type MaskPreparationWorkerScope = {
  addEventListener(
    type: "message",
    listener: (
      event: MessageEvent<
        | MaskPreparationWorkerRequest
        | HeatmapPreparationWorkerRequest
        | DepthPreparationWorkerRequest
        | DepthPreviewLumaWorkerRequest
      >,
    ) => void,
  ): void;
  postMessage(message: PreparationWorkerResponse): void;
  postMessage(
    message: PreparationWorkerResponse,
    transfer: Transferable[],
  ): void;
};

const workerScope = globalThis as unknown as MaskPreparationWorkerScope;

workerScope.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === HeatmapPreparationWorkerMessageType.Prepare) {
    prepareHeatmap(message);
    return;
  }

  if (message.type === DepthPreparationWorkerMessageType.Decode) {
    void decodeDepthFrame(message);
    return;
  }

  if (message.type === DepthPreparationWorkerMessageType.PreviewLuma) {
    void copyPreviewLuma(message);
    return;
  }

  if (message.type !== MaskPreparationWorkerMessageType.Prepare) {
    return;
  }

  prepareMaskFrame(message);
});

function prepareHeatmap(message: HeatmapPreparationWorkerRequest) {
  try {
    const data = colorizeHeatmap(message.map, message.renderer);
    const imageData = new ImageData(
      data,
      message.map.width,
      message.map.height,
    );
    const imageBitmap = createImageBitmapFromImageData(imageData);

    if (imageBitmap) {
      workerScope.postMessage(
        {
          imageBitmap,
          requestId: message.requestId,
          type: HeatmapPreparationWorkerMessageType.Complete,
        },
        [imageBitmap],
      );
      return;
    }

    workerScope.postMessage(
      {
        imageData,
        requestId: message.requestId,
        type: HeatmapPreparationWorkerMessageType.Complete,
      },
      [imageData.data.buffer],
    );
  } catch (error) {
    workerScope.postMessage({
      error:
        error instanceof Error ? error.message : "Unable to prepare heatmap.",
      requestId: message.requestId,
      type: HeatmapPreparationWorkerMessageType.Error,
    });
  }
}

/** Decoding waits on the platform's inflate, so replies arrive out of order. */
async function decodeDepthFrame(message: DepthPreparationWorkerRequest) {
  const { response, transfer } = await decodeDepthPreparationRequest(message);

  workerScope.postMessage(response, transfer);
}

const previewLumaScratch: DepthPreviewLumaScratch = {
  buffer: new ArrayBuffer(0),
};
/** Frames arrive in order and are copied in order, through one scratch. */
let previewLumaQueue: Promise<void> = Promise.resolve();

function copyPreviewLuma(message: DepthPreviewLumaWorkerRequest) {
  previewLumaQueue = previewLumaQueue.then(async () => {
    try {
      const copied = await readVideoFrameLuma(
        message.frame,
        previewLumaScratch,
        message.correction,
      );

      workerScope.postMessage(
        {
          height: copied.height,
          luma: copied.luma.buffer as ArrayBuffer,
          path: copied.path,
          requestId: message.requestId,
          type: DepthPreparationWorkerMessageType.PreviewLumaComplete,
          width: copied.width,
        },
        [copied.luma.buffer as ArrayBuffer],
      );
    } catch (error) {
      workerScope.postMessage({
        error:
          error instanceof Error
            ? error.message
            : "Unable to copy the depth preview frame.",
        requestId: message.requestId,
        type: DepthPreparationWorkerMessageType.Error,
      });
    } finally {
      message.frame.close();
    }
  });

  return previewLumaQueue;
}

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
          sourceWidth: idMaskFrame.sourceWidth,
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
    const idMaskPlane = createIdMaskPlane(
      message.job.instructions,
      message.job.maxRasterWidth,
    );
    const idMaskTransfers = idMaskPlane ? [idMaskPlane.data.buffer] : [];

    if (imageBitmap) {
      workerScope.postMessage(
        {
          idMaskPlane,
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
        idMaskPlane,
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
