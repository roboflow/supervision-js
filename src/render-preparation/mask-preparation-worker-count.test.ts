import { describe, expect, it } from "vitest";

import { resolveMaskPreparationWorkerCount } from "./mask-preparation-worker-count";

describe("mask preparation worker count", () => {
  it.each([
    { expected: 1, hardwareConcurrency: 1 },
    { expected: 1, hardwareConcurrency: 2 },
    { expected: 2, hardwareConcurrency: 4 },
    { expected: 4, hardwareConcurrency: 8 },
    { expected: 4, hardwareConcurrency: 16 },
    { expected: 2, hardwareConcurrency: undefined },
  ])(
    "resolves a sensible automatic count for $hardwareConcurrency cores",
    ({ expected, hardwareConcurrency }) => {
      expect(resolveMaskPreparationWorkerCount({ hardwareConcurrency })).toBe(
        expected,
      );
    },
  );

  it.each([
    { expected: 1, requestedWorkerCount: 0 },
    { expected: 1, requestedWorkerCount: 1.8 },
    { expected: 4, requestedWorkerCount: 4 },
    { expected: 8, requestedWorkerCount: 30 },
  ])(
    "clamps requested worker count $requestedWorkerCount to $expected",
    ({ expected, requestedWorkerCount }) => {
      expect(resolveMaskPreparationWorkerCount({ requestedWorkerCount })).toBe(
        expected,
      );
    },
  );
});
