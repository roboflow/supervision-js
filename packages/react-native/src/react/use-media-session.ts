import { useEffect, useState } from "react";

import type { MediaSession, MediaSessionState } from "../types/media-session";

export interface UseMediaSessionResult {
  readonly error: unknown;
  readonly session: MediaSession | null;
  readonly state: MediaSessionState | null;
}

/**
 * React lifecycle sugar for a vanilla media session.
 *
 * React owns only creation, subscription, and teardown. Frame pumping and
 * presentation remain in the session and its renderer adapters.
 */
export function useMediaSession(
  create: () => Promise<MediaSession>,
  dependencies: readonly unknown[],
): UseMediaSessionResult {
  const [result, setResult] = useState<UseMediaSessionResult>({
    error: null,
    session: null,
    state: null,
  });

  useEffect(() => {
    let active = true;
    let session: MediaSession | null = null;
    let unsubscribe: (() => void) | null = null;

    setResult({ error: null, session: null, state: null });

    void create().then(
      (created) => {
        if (!active) {
          void destroySession(created, () => undefined);
          return;
        }

        session = created;
        unsubscribe = created.subscribe((state) => {
          if (active) {
            setResult({ error: null, session: created, state });
          }
        });
        setResult({
          error: null,
          session: created,
          state: created.getState(),
        });
      },
      (error: unknown) => {
        if (active) {
          setResult({ error, session: null, state: null });
        }
      },
    );

    return () => {
      active = false;
      unsubscribe?.();
      if (session) {
        void destroySession(session, () => undefined);
      }
    };
  }, dependencies);

  return result;
}

function destroySession(
  session: MediaSession,
  onError: (error: unknown) => void,
) {
  return session.destroy().catch((error: unknown) => {
    onError(error);
  });
}
