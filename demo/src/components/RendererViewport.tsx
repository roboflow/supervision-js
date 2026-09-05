import { memo, type CSSProperties, type RefCallback } from "react";

import { DemoEvalHook } from "../eval-hooks";
import { sameViewportOverlay, type ViewportOverlay } from "./viewport-overlay";

interface RendererViewportProps {
  readonly containerRef: RefCallback<HTMLDivElement>;
  /** Detail is withheld until the wait has lasted long enough to need naming. */
  readonly explained: boolean;
  readonly overlay: ViewportOverlay | null;
}

export const RendererViewport = memo(function RendererViewport({
  containerRef,
  explained,
  overlay,
}: RendererViewportProps) {
  return (
    <section className="renderer-viewport" aria-label="Renderer viewport">
      <div
        ref={containerRef}
        className="renderer-viewport__mount"
        data-eval={DemoEvalHook.ViewportMount}
      />
      {overlay ? (
        <div
          className={`renderer-viewport__overlay renderer-viewport__overlay--${overlay.tone}`}
        >
          <div className="renderer-viewport__overlay-card">
            <span className="renderer-viewport__overlay-kicker">
              {overlay.kicker}
            </span>
            <strong>{overlay.label}</strong>
            {explained && overlay.detail ? <span>{overlay.detail}</span> : null}
            {overlay.progress !== null ? (
              <div className="renderer-viewport__overlay-progress">
                <span
                  style={
                    {
                      "--overlay-progress": `${Math.round(
                        overlay.progress * 100,
                      )}%`,
                    } as OverlayProgressStyle
                  }
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}, areRendererViewportPropsEqual);

function areRendererViewportPropsEqual(
  previousProps: RendererViewportProps,
  nextProps: RendererViewportProps,
) {
  return (
    previousProps.containerRef === nextProps.containerRef &&
    previousProps.explained === nextProps.explained &&
    sameViewportOverlay(previousProps.overlay, nextProps.overlay)
  );
}

type OverlayProgressStyle = CSSProperties & {
  readonly "--overlay-progress": string;
};
