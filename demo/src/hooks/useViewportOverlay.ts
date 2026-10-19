import { useRef } from "react";

import {
  createViewportOverlay,
  isViewerLeadingPlayback,
  type ViewportOverlay,
} from "../components/viewport-overlay";
import type {
  DemoMediaState,
  UploadInferenceState,
} from "../session/demo-session-types";
import type { MediaSessionState } from "supervision";
import { useOverlayGate } from "./useOverlayGate";

export function useViewportOverlay(
  sessionState: MediaSessionState | null,
  uploadInferenceState: UploadInferenceState | null,
  mediaState: DemoMediaState,
): { explained: boolean; overlay: ViewportOverlay | null } {
  const overlay = createViewportOverlay(
    sessionState,
    uploadInferenceState,
    mediaState,
  );
  const shownRef = useRef<ViewportOverlay | null>(null);
  const gate = useOverlayGate({
    hasOverlay: overlay !== null,
    isError: overlay?.tone === "error",
    isSuppressed: isViewerLeadingPlayback(sessionState),
  });

  if (overlay) {
    shownRef.current = overlay;
  }

  return {
    explained: gate.explained,
    overlay: gate.visible ? shownRef.current : null,
  };
}
