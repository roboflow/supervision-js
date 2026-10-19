/**
 * A comparable description of everything a render would put on screen. Values
 * are compared position by position with `Object.is`, so a notification whose
 * description matches the one already drawn costs nothing.
 */
export type SceneRenderSignature = readonly unknown[];

export interface SceneRenderScheduler {
  /** Renders only when the description differs from what was last drawn. */
  renderOnChange(signature: SceneRenderSignature): boolean;
  /** Renders whatever the description says, for pixels that changed outside it. */
  render(signature: SceneRenderSignature): void;
  /** Renders this scheduler issued, which is every render under its policy. */
  getRenderCount(): number;
}

/**
 * Turns change notifications into renders. It owns no timer, no ticker and no
 * animation frame: a scheduler nobody notifies renders nothing, forever.
 */
export function createSceneRenderScheduler(
  draw: () => void,
): SceneRenderScheduler {
  let drawnSignature: SceneRenderSignature | null = null;
  let renderCount = 0;

  const render = (signature: SceneRenderSignature) => {
    drawnSignature = signature;
    renderCount += 1;
    draw();
  };

  return {
    getRenderCount() {
      return renderCount;
    },

    render,

    renderOnChange(signature) {
      if (drawnSignature !== null && matches(drawnSignature, signature)) {
        return false;
      }

      render(signature);
      return true;
    },
  };
}

function matches(left: SceneRenderSignature, right: SceneRenderSignature) {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
