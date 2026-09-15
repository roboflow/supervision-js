import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SUITE = fileURLToPath(new URL("./run-pose.test.py", import.meta.url));
const CI_WORKFLOW = fileURLToPath(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
);

/**
 * `run-pose.py` decodes frames with Pillow, so an interpreter without it cannot
 * exercise the script at all. Reporting that as a skip keeps the suite honest
 * about what ran instead of passing on an interpreter that never opened it.
 */
function findInterpreter() {
  for (const runtime of ["python3", "python"]) {
    const probe = spawnSync(runtime, ["-c", "import PIL"], {
      encoding: "utf8",
    });

    if (probe.status === 0) {
      return runtime;
    }
  }

  return null;
}

describe("run-pose.py", () => {
  const interpreter = findInterpreter();

  it(
    "passes its offline suite against a stubbed Ultralytics",
    { skip: interpreter ? false : "no Python interpreter with Pillow" },
    () => {
      const run = spawnSync(interpreter, [SUITE], { encoding: "utf8" });

      assert.equal(run.status, 0, `${run.stdout ?? ""}${run.stderr ?? ""}`);
    },
  );

  it("is given the interpreter it needs on CI", () => {
    const workflow = readFileSync(CI_WORKFLOW, "utf8");

    assert.match(
      workflow,
      /uses: actions\/setup-python/,
      "CI has no Python step, so the suite above reports a skip and passes",
    );
    assert.match(
      workflow,
      /pip install .*Pillow/,
      "CI installs no Pillow, so the suite above reports a skip and passes",
    );
  });
});
