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

test("npm uses OIDC and GitHub releases use the automatic token in a separate job", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const releaseStart = workflow.indexOf("\n  github-release:");
  assert.ok(releaseStart > 0, "GitHub releases must run in a separate job");
  const publishJob = workflow.slice(0, releaseStart);
  const releaseJob = workflow.slice(releaseStart);

  assert.match(publishJob, /contents: read/);
  assert.match(publishJob, /id-token: write/);
  assert.doesNotMatch(publishJob, /contents: write/);
  assert.match(releaseJob, /needs: publish/);
  assert.match(releaseJob, /if: inputs\.dist_tag == 'latest'/);
  assert.match(releaseJob, /contents: write/);
  assert.doesNotMatch(releaseJob, /id-token: write/);
  assert.match(releaseJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(releaseJob, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|create-github-app-token|RELEASE_APP_|recovery_run_id/,
  );
  assert.match(
    releaseJob,
    /name: Create or verify release tag[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*?gh auth setup-git --hostname github\.com\n *git push origin "refs\/tags\/\$\{tag\}"/,
  );
  assert.match(
    releaseJob,
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
