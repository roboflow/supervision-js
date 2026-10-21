import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const workflowPath = path.join(
  process.cwd(),
  ".github/workflows/publish-npm.yml",
);

test("npm publish waits for the selected dist-tag to propagate", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /attempts=60/);
  assert.match(workflow, /for attempt in \$\(seq 1 "\$\{attempts\}"\); do/);
  assert.match(
    workflow,
    /npm view "supervision@\$\{DIST_TAG\}" version 2>\/dev\/null \|\| true/,
  );
  assert.match(workflow, /sleep 5/);
  assert.match(
    workflow,
    /did not resolve to \$\{version\} after \$\(\(attempts \* 5\)\) seconds/,
  );
  assert.match(workflow, /git config user\.name "github-actions\[bot\]"/);
  assert.match(
    workflow,
    /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/,
  );
});

test("GitHub releases use the automatic job token without a personal access token", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /secrets\.|RELEASE_GITHUB_TOKEN/);
  assert.match(
    workflow,
    /name: Check out repository[\s\S]*?fetch-depth: 0[\s\S]*?persist-credentials: false/,
  );
  assert.match(
    workflow,
    /name: Create or verify release tag[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*?gh auth setup-git --hostname github\.com\n *git push origin "refs\/tags\/\$\{tag\}"/,
  );
  assert.match(
    workflow,
    /name: Create GitHub Release[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}/,
  );
});

test("the release publishes the one package this repository ships", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const publishes = workflow.match(/^ *npm publish /gm) ?? [];

  assert.equal(
    publishes.length,
    1,
    "A second publish step would need its own ordering, dist-tag verification and recovery path",
  );
  assert.match(workflow, /archives=\(artifacts\/supervision-\*\.tgz\)/);
  assert.doesNotMatch(
    workflow,
    /supervision-js-web-video-engine/,
    "The video engine ships as a subpath of supervision and has no release of its own",
  );
});
