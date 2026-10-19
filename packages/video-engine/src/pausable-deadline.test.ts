import { afterEach, describe, expect, it, vi } from "vitest";

import { createPausableDeadline } from "./pausable-deadline";

afterEach(() => vi.useRealTimers());

describe("pausable deadline", () => {
  it.each([-3_600_000, 3_600_000])(
    "keeps its visible budget when the wall clock moves by %i ms",
    (clockJump) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
      });
      const expired = vi.fn();
      const deadline = createPausableDeadline(40_000, expired);

      vi.advanceTimersByTime(1000);
      vi.setSystemTime(Date.now() + clockJump);
      deadline.pause();
      vi.advanceTimersByTime(60_000);
      deadline.resume();
      vi.advanceTimersByTime(38_999);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(expired).toHaveBeenCalledOnce();
    },
  );
});
