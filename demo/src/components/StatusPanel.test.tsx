import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  DetectionBufferStatus,
  MediaErrorKind,
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision";
import { describe, expect, it } from "vitest";

import { StatusPanel } from "./StatusPanel";

interface ReadoutProps {
  readonly label?: string;
  readonly title?: string;
  readonly value?: ReactNode;
  readonly children?: ReactNode;
}

type PanelProps = Parameters<typeof StatusPanel.type>[0];

function readout(tree: ReactNode, label: string): ReadoutProps {
  const found = collect(tree).filter((node) => node.props.label === label);

  if (found.length !== 1) {
    throw new Error(`${found.length} readouts are labelled "${label}"`);
  }

  return found[0].props;
}

function collect(
  node: ReactNode,
  found: ReactElement<ReadoutProps>[] = [],
): ReactElement<ReadoutProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, found);
    }
    return found;
  }

  if (!isValidElement<ReadoutProps>(node)) {
    return found;
  }

  found.push(node);

  return collect(node.props.children, found);
}

function renderPanel(overrides: Partial<PanelProps> = {}) {
  return StatusPanel.type({
    detectionSourceState: {
      datasetId: null,
      errorMessage: null,
      sourceSummary: null,
      status: "idle",
    },
    errorMessage: null,
    fixtureSummary: null,
    hoveredDetectionPick: null,
    mediaState: { errorMessage: null, status: "ready" },
    playbackState: MediaRendererPlaybackState.Paused,
    presentedRate: null,
    renderPreparationDiagnostics: null,
    rendererState: null,
    selectedDetectionPick: null,
    sessionState: null,
    sourceState: sourceState(0),
    ...overrides,
  });
}

function sourceState(audioTrackCount: number | null): MediaSourceState {
  return {
    audioTrackCount,
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
    trackCount: 2,
    videoTrackCount: 1,
  };
}

function rendererState(
  overrides: Partial<MediaRendererState> = {},
): MediaRendererState {
  return {
    activeDetectionCount: 0,
    activeDetectionFrameIndex: 3,
    activeDetectionFrameTime: 0.1333,
    currentTime: 0.1333,
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
    duration: 10,
    fit: MediaRendererFit.Contain,
    lastFrameRenderTimings: null,
    maskHeldStale: false,
    mediaHeight: 240,
    mediaWidth: 320,
    playbackRate: 1,
    playbackState: MediaRendererPlaybackState.Paused,
    presentedFrames: 1,
    rendererBackend: "webgpu",
    source: sourceState(0),
    ...overrides,
  };
}

describe("StatusPanel", () => {
  it("reads the audio track count off the source it opened", () => {
    expect(readout(renderPanel(), "Audio").value).toBe("video-only source");
    expect(
      readout(renderPanel({ sourceState: sourceState(2) }), "Audio").value,
    ).toBe("2 audio tracks");
  });

  it("says when the mask on screen belongs to an older frame than the boxes", () => {
    const matched = renderPanel({
      rendererState: rendererState({ drawnMaskFrameTime: 0.1333 }),
    });
    const stale = renderPanel({
      rendererState: rendererState({
        drawnMaskFrameTime: 0.1,
        maskHeldStale: true,
      }),
    });

    expect(String(readout(matched, "Mask Frame").value)).not.toContain("stale");
    // Nothing else on the panel names the frame the raster really belongs to.
    expect(String(readout(stale, "Mask Frame").value)).toContain("stale");
  });

  it("says which side of the picture a held raster sits on", () => {
    const forwards = renderPanel({
      rendererState: rendererState({
        activeDetectionFrameTime: 0.1333,
        drawnMaskFrameTime: 0.1,
        maskHeldStale: true,
      }),
    });
    const backwards = renderPanel({
      rendererState: rendererState({
        activeDetectionFrameTime: 0.1,
        drawnMaskFrameTime: 0.1333,
        maskHeldStale: true,
      }),
    });

    expect(String(readout(forwards, "Mask Frame").value)).toContain(
      "33.30ms behind",
    );
    expect(String(readout(backwards, "Mask Frame").value)).toContain(
      "33.30ms ahead",
    );
  });
});
