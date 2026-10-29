import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const workflowPath = path.join(
  process.cwd(),
  ".github/workflows/publish-npm.yml",
);

/** The text of one top-level job, up to the next job. */
function jobSource(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `Missing ${name} job`);
  const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return next < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + next);
}

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
  const publishJob = jobSource(workflow, "publish");
  const releaseJob = jobSource(workflow, "github-release");

  assert.match(publishJob, /contents: read/);
  assert.match(publishJob, /id-token: write/);
  assert.doesNotMatch(publishJob, /contents: write/);
  assert.equal(
    workflow.match(/id-token: write/g)?.length,
    1,
    "Only the npm job may request an OIDC token",
  );
  assert.match(releaseJob, /needs: \[resolve, publish\]/);
  assert.match(releaseJob, /if: needs\.resolve\.outputs\.dist_tag == 'latest'/);
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

test("a dispatched version opens a release pull request instead of publishing", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const prepareJob = jobSource(workflow, "prepare");
  const resolveJob = jobSource(workflow, "resolve");

  assert.match(
    prepareJob,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.version != ''/,
  );
  assert.match(
    resolveJob,
    /if: github\.event_name == 'push' \|\| inputs\.version == ''/,
  );
  assert.match(prepareJob, /node tools\/set-release-version\.mjs/);
  assert.match(prepareJob, /persist-credentials: false/);
  assert.match(prepareJob, /gh pr create/);
  assert.doesNotMatch(prepareJob, /npm publish|gh release create/);

  // A pull request opened with the automatic token starts no workflows, so the
  // release branch must dispatch the CI run that reports the required check.
  assert.match(prepareJob, /actions: write/);
  assert.match(prepareJob, /gh workflow run ci\.yml/);
  const ci = await readFile(
    path.join(process.cwd(), ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(ci, /^ {2}workflow_dispatch:/m);
});

test("merging a version change to main publishes it once", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const resolveJob = jobSource(workflow, "resolve");
  const publishJob = jobSource(workflow, "publish");

  assert.match(
    workflow,
    /\n {2}push:\n {4}branches:\n {6}- main\n {4}paths:\n {6}- packages\/web\/package\.json\n/,
  );
  assert.match(
    resolveJob,
    /if npm view "supervision@\$\{version\}" version >\/dev\/null 2>&1; then[\s\S]*?publish=false/,
  );
  assert.match(publishJob, /needs: resolve/);
  assert.match(publishJob, /needs\.resolve\.outputs\.publish == 'true'/);
  assert.match(publishJob, /group: npm-publish/);
  assert.doesNotMatch(
    publishJob,
    /DIST_TAG: \$\{\{ inputs\.dist_tag/,
    "Push events have no inputs; the publish steps take the resolved tag",
  );
});
