import { useEffect, useRef, useState } from "react";

import {
  advanceOverlayGate,
  IDLE_OVERLAY_GATE,
  type OverlayGateState,
} from "../components/overlay-gate";

export interface OverlayGate {
  readonly explained: boolean;
  readonly visible: boolean;
}

export function useOverlayGate(input: {
  hasOverlay: boolean;
  isError: boolean;
}): OverlayGate {
  const stateRef = useRef<OverlayGateState>(IDLE_OVERLAY_GATE);
  const [gate, setGate] = useState<OverlayGate>({
    explained: false,
    visible: false,
  });
  const { hasOverlay, isError } = input;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = () => {
      const result = advanceOverlayGate(
        stateRef.current,
        { hasOverlay, isError },
        performance.now(),
      );

      stateRef.current = result.state;
      setGate((previous) =>
        previous.explained === result.explained &&
        previous.visible === result.visible
          ? previous
          : { explained: result.explained, visible: result.visible },
      );

      if (result.wakeInMs !== null) {
        timer = setTimeout(settle, result.wakeInMs);
      }
    };

    settle();

    return () => clearTimeout(timer);
  }, [hasOverlay, isError]);

  return gate;
}
