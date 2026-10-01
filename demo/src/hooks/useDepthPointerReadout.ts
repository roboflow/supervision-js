import { useCallback, useRef, useState, type PointerEvent } from "react";
import {
  readDepthAt,
  type ActiveDepthMap,
  type DepthReadout,
  type MediaRenderer,
} from "supervision";

interface DepthPointerState {
  readonly active: ActiveDepthMap | null;
  readonly readout: DepthReadout | null;
}

/**
 * The depth on screen and the value under the pointer. `refresh` reads both
 * again, so a host calls it whenever the frame or its depth may have changed:
 * the pointer can rest while a step lands new depth under it.
 */
export function useDepthPointerReadout(
  getRenderer: () => MediaRenderer | null,
) {
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<DepthPointerState>({
    active: null,
    readout: null,
  });

  const refresh = useCallback(() => {
    const renderer = getRenderer();
    const active = renderer?.getActiveDepth?.() ?? null;
    const pointer = pointerRef.current;

    setState({
      active,
      readout:
        renderer && active && pointer
          ? readDepthAt(active.map, renderer.screenToMedia(pointer), {
              height: active.mediaHeight,
              width: active.mediaWidth,
            })
          : null,
    });
  }, [getRenderer]);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();

      pointerRef.current = {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      };
      refresh();
    },
    [refresh],
  );

  const onPointerLeave = useCallback(() => {
    pointerRef.current = null;
    refresh();
  }, [refresh]);

  return { ...state, onPointerLeave, onPointerMove, refresh };
}
