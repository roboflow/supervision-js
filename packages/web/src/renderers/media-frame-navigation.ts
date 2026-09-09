import type { MediaFrameClock } from "#types/media-frame-clock";
import type {
  MediaFrameLanding,
  MediaFrameNavigation,
  MediaFrameScrub,
  MediaFrameScrubSettlement,
} from "#types/media-frame-navigation";

export interface MediaFrameNavigationController {
  readonly api: MediaFrameNavigation;
  presented(frame: {
    readonly index: number;
    readonly mediaTime: number;
  }): void;
  cancel(): void;
  destroy(error?: unknown): void;
}

interface MoveOperation {
  readonly kind: "move";
  readonly target: MediaFrameLanding;
  readonly resolve: (landing: MediaFrameLanding) => void;
  readonly reject: (error: unknown) => void;
  presented: boolean;
}

interface ScrubOperation {
  readonly kind: "scrub";
  readonly target: MediaFrameLanding;
  readonly resolve: (settlement: MediaFrameScrubSettlement) => void;
}

type NavigationOperation = MoveOperation | ScrubOperation;

export function createMediaFrameNavigation(options: {
  readonly clock: MediaFrameClock;
  readonly seek: (mediaTime: number) => Promise<void>;
  readonly scrub: (mediaTime: number) => void;
}): MediaFrameNavigationController {
  let activeOperation: NavigationOperation | null = null;
  let displayed: { readonly index: number; readonly mediaTime: number } | null =
    null;
  let destroyed = false;
  let destroyError: unknown;

  const controller: MediaFrameNavigationController = {
    api: {
      moveToFrame(index) {
        return startMove(() => landingAt(index));
      },

      moveToTime(mediaTime) {
        return startMove(() =>
          landingAt(options.clock.indexAtOrBefore(mediaTime)),
        );
      },

      scrubToFrame(index) {
        const target = landingAt(index);

        return startScrub(target);
      },

      scrubToTime(mediaTime) {
        const target = landingAt(options.clock.indexAtOrBefore(mediaTime));

        return startScrub(target);
      },
    },

    presented(frame) {
      displayed = frame;
      const operation = activeOperation;

      if (
        !operation ||
        frame.index !== operation.target.index ||
        frame.mediaTime !== operation.target.mediaTime
      ) {
        return;
      }

      if (operation.kind === "scrub") {
        activeOperation = null;
        operation.resolve({ frame: operation.target, status: "landed" });
        return;
      }

      operation.presented = true;
    },

    cancel() {
      supersedeActive(
        createAbortError("Media frame navigation was superseded."),
      );
    },

    destroy(error) {
      if (destroyed) {
        return;
      }

      destroyed = true;
      destroyError =
        error ?? createAbortError("Media frame navigation was destroyed.");
      supersedeActive(destroyError);
    },
  };

  return controller;

  function landingAt(index: number): MediaFrameLanding {
    return {
      duration: options.clock.durationAt(index),
      index,
      mediaTime: options.clock.timeAt(index),
    };
  }

  function startMove(
    getTarget: () => MediaFrameLanding,
  ): Promise<MediaFrameLanding> {
    if (destroyed) {
      return own(Promise.reject(destroyError));
    }

    let target: MediaFrameLanding;

    try {
      target = getTarget();
    } catch (error) {
      return own(Promise.reject(error));
    }

    supersedeActive(createAbortError("Media frame navigation was superseded."));

    let resolve!: (landing: MediaFrameLanding) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MediaFrameLanding>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      },
    );
    const operation: MoveOperation = {
      kind: "move",
      presented: false,
      reject,
      resolve,
      target,
    };

    activeOperation = operation;

    let command: Promise<void>;

    try {
      command = options.seek(target.mediaTime);
    } catch (error) {
      failMove(operation, error);
      return own(promise);
    }

    void Promise.resolve(command).then(
      () => {
        if (activeOperation !== operation) {
          return;
        }

        if (!operation.presented && !isDisplayed(operation.target)) {
          failMove(
            operation,
            new Error(
              "Media seek completed without presenting the requested exact frame.",
            ),
          );
          return;
        }

        activeOperation = null;
        operation.resolve(operation.target);
      },
      (error: unknown) => {
        failMove(operation, error);
      },
    );

    return own(promise);
  }

  function startScrub(target: MediaFrameLanding): MediaFrameScrub {
    if (destroyed) {
      throw destroyError;
    }

    supersedeActive(createAbortError("Media frame navigation was superseded."));

    let resolve!: (settlement: MediaFrameScrubSettlement) => void;
    const settled = new Promise<MediaFrameScrubSettlement>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const operation: ScrubOperation = {
      kind: "scrub",
      resolve,
      target,
    };

    activeOperation = operation;
    own(settled);

    try {
      options.scrub(target.mediaTime);
      if (activeOperation === operation && isDisplayed(target)) {
        activeOperation = null;
        operation.resolve({ frame: target, status: "landed" });
      }
    } catch (error) {
      if (activeOperation === operation) {
        activeOperation = null;
        operation.resolve({ status: "superseded" });
      }
      throw error;
    }

    return { settled, target };
  }

  function isDisplayed(target: MediaFrameLanding): boolean {
    return (
      displayed?.index === target.index &&
      displayed.mediaTime === target.mediaTime
    );
  }

  function failMove(operation: MoveOperation, error: unknown) {
    if (activeOperation !== operation) {
      return;
    }

    activeOperation = null;
    operation.reject(error);
  }

  function supersedeActive(error: unknown) {
    const operation = activeOperation;

    if (!operation) {
      return;
    }

    activeOperation = null;
    if (operation.kind === "move") {
      operation.reject(error);
    } else {
      operation.resolve({ status: "superseded" });
    }
  }
}

function own<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function createAbortError(message: string) {
  return new DOMException(message, "AbortError");
}
