import { memo, useCallback, useRef } from "react";
import {
  useLiveReadoutWriter,
  type LiveReadouts,
} from "../hooks/live-readouts";

/**
 * A readout whose text is written straight to its own text node rather than
 * rendered. React holds an element with no children, so a commit anywhere in
 * the control bar leaves this leaf alone and the number is free to move at the
 * rate the player reports it.
 */
export const LiveReadoutText = memo(function LiveReadoutText({
  className,
  format,
}: {
  readonly className?: string;
  readonly format: (readouts: LiveReadouts) => string;
}) {
  const textRef = useRef<Text | null>(null);
  const writtenRef = useRef<string | null>(null);
  /* The text node is kept and its data rewritten. Assigning textContent drops
   * the node and builds another, which costs a child-list mutation and a fresh
   * layout object on every frame that carries a new number. */
  const mount = useCallback((node: HTMLSpanElement | null) => {
    if (node === null) {
      textRef.current = null;
      return;
    }

    const text = document.createTextNode(writtenRef.current ?? "");

    node.replaceChildren(text);
    textRef.current = text;
  }, []);

  useLiveReadoutWriter((readouts) => {
    const next = format(readouts);

    if (next === writtenRef.current) {
      return;
    }

    writtenRef.current = next;

    if (textRef.current !== null) {
      textRef.current.data = next;
    }
  });

  return <span className={className} ref={mount} />;
});
