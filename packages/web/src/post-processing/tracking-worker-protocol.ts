import type {
  TrackingAssignment,
  TrackingDetectionPostProcessor,
  TrackingProjection,
} from "supervision-js-core";
import type { WorkerRpcMessage } from "#workers/worker-rpc-client";

export type TrackingWorkerRequest =
  | TrackingWorkerConfigureRequest
  | TrackingWorkerProcessRequest
  | TrackingWorkerResetRequest;

export interface TrackingWorkerConfigureRequest extends WorkerRpcMessage {
  readonly type: "configure";
  readonly processor: TrackingDetectionPostProcessor;
}

export interface TrackingWorkerProcessRequest extends WorkerRpcMessage {
  readonly type: "process";
  readonly detections: readonly TrackingProjection[];
  readonly frameIndex: number;
}

export interface TrackingWorkerResetRequest extends WorkerRpcMessage {
  readonly type: "reset";
}

export type TrackingWorkerResponse =
  TrackingWorkerSuccessResponse | TrackingWorkerErrorResponse;

export interface TrackingWorkerSuccessResponse extends WorkerRpcMessage {
  readonly type: "success";
  readonly activeTrackCount?: number;
  readonly assignments?: readonly TrackingAssignment[];
  readonly confirmedTrackCount?: number;
  readonly durationMs?: number;
}

export interface TrackingWorkerErrorResponse extends WorkerRpcMessage {
  readonly type: "error";
  readonly message: string;
}

export function isTrackingWorkerResponse(
  value: unknown,
): value is TrackingWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TrackingWorkerResponse>;
  return (
    typeof candidate.requestId === "number" &&
    (candidate.type === "success" ||
      (candidate.type === "error" && typeof candidate.message === "string"))
  );
}
