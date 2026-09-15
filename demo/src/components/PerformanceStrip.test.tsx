import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  DetectionBufferStatus,
  MediaErrorKind,
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaFrameRenderTimings,
  type MediaRendererState,
} from "supervision";
import { describe, expect, it } from "vitest";

import { PerformanceStrip } from "./PerformanceStrip";

interface MetricProps {
  readonly label?: string;
  readonly tone?: string;
  readonly value?: string;
  readonly children?: ReactNode;
}

function chip(tree: ReactNode, label: string): MetricProps {
  const found = collect(tree).filter((node) => node.props.label === label);

  if (found.length !== 1) {
    throw new Error(`${found.length} chips are labelled "${label}"`);
  }

  return found[0].props;
}

function collect(
  node: ReactNode,
  found: ReactElement<MetricProps>[] = [],
): ReactElement<MetricProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }
    return found;
  }

  if (!isValidElement<MetricProps>(node)) {
    return found;
  }

  if (node.props.label !== undefined) {
    found.push(node);
  }

  return collect(node.props.children, found);
}

function renderStrip(timings: MediaFrameRenderTimings | null) {
  return PerformanceStrip.type({
    renderPreparationDiagnostics: null,
    rendererState: rendererState(timings),
    sourceFrameRate: 30,
  });
}

function rendererState(
  lastFrameRenderTimings: MediaFrameRenderTimings | null,
): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: null,
    activeDetectionFrameTime: null,
    currentTime: 0,
    detectionBuffer: {
      bufferEndTime: null,
      bufferStartTime: null,
      detectionCount: 0,
      errorMessage: null,
      frameCount: 0,
      requestedEndTime: null,
      requestedStartTime: null,
      status: DetectionBufferStatus.Idle,
    },
    drawnMaskFrameTime: null,
    duration: null,
    fit: MediaRendererFit.Contain,
    lastFrameRenderTimings,
    maskHeldStale: false,
    mediaHeight: 240,
    mediaWidth: 320,
    playbackRate: 1,
    playbackState: MediaRendererPlaybackState.Paused,
    presentedFrames: 0,
    rendererBackend: "webgpu",
    source: {
      audioTrackCount: 0,
      canRead: true,
      duration: 10,
      errorKind: null as MediaErrorKind | null,
      errorMessage: null,
      estimatedFrameCount: 300,
      estimatedFrameRate: 30,
      firstTimestamp: 0,
      formatMimeType: "video/mp4",
      formatName: "mp4",
      mimeType: "video/mp4",
      primaryVideoHeight: 240,
      primaryVideoWidth: 320,
      status: MediaSourceStatus.Ready,
      trackCount: 1,
      videoTrackCount: 1,
    },
  };
}

function timings(totalMs: number): MediaFrameRenderTimings {
  return {
    boxMs: 0,
    fitMs: 0,
    focusMs: 0,
    interactionMs: 0,
    labelMs: 0,
    maskMs: 0,
    mediaUploadMs: 0,
    totalMs,
  };
}

describe("PerformanceStrip", () => {
  it("grades the frames it measures and passes no verdict on the ones it does not", () => {
    const unmeasured = chip(renderStrip(null), "Frame");

    // "good" is a verdict, and a chip with nothing behind it reads as one at a
    // glance: a green border on the always-visible strip says the frame budget
    // is being met.
    expect(unmeasured.value).toBe("-");
    expect(unmeasured.tone).not.toBe("good");
    expect(chip(renderStrip(timings(4.2)), "Frame").tone).toBe("good");
    expect(chip(renderStrip(timings(25)), "Frame").tone).toBe("warn");
  });
});
