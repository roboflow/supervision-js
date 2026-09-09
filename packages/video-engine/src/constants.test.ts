import { describe, expect, it } from "vitest";

import { HANG_RECOVERY } from "./constants";

describe("hang recovery ceilings", () => {
  it("bounds the seed more tightly than a random-access decode", () => {
    expect(HANG_RECOVERY.SEED_HANG_TIMEOUT_MS).toBeLessThan(
      HANG_RECOVERY.DECODE_HANG_TIMEOUT_MS,
    );
  });

  it("leaves the worker room to spend every seed attempt and still answer", () => {
    const spentOnSeeding =
      HANG_RECOVERY.SEED_DECODE_ATTEMPTS * HANG_RECOVERY.SEED_HANG_TIMEOUT_MS;

    expect(spentOnSeeding).toBeLessThan(
      HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS,
    );
  });

  it("gives the worker longer than the decode it is waiting on", () => {
    expect(HANG_RECOVERY.DECODE_HANG_TIMEOUT_MS).toBeLessThan(
      HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS,
    );
  });

  it("ends a missing presentation while its specific error can still cross the worker boundary", () => {
    expect(HANG_RECOVERY.DECODE_HANG_TIMEOUT_MS).toBeLessThan(
      HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS,
    );
    expect(HANG_RECOVERY.PRESENTATION_LATCH_TIMEOUT_MS).toBeLessThan(
      HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS,
    );
  });
});
