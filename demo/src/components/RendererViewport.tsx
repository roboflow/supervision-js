import type { RefObject } from "react";

export function RendererViewport({
  containerRef,
}: {
  readonly containerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="renderer-viewport" aria-label="Renderer viewport">
      <div ref={containerRef} className="renderer-viewport__mount" />
    </section>
  );
}
