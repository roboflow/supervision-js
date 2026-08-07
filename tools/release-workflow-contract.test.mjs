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

  assert.match(workflow, /for attempt in \{1\.\.12\}; do/);
  assert.match(
    workflow,
    /npm view "supervision@\$\{DIST_TAG\}" version 2>\/dev\/null \|\| true/,
  );
  assert.match(workflow, /sleep 5/);
  assert.match(workflow, /did not resolve to \$\{version\} after 60 seconds/);
  assert.match(workflow, /git config user\.name "github-actions\[bot\]"/);
  assert.match(
    workflow,
    /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"/,
  );
});

test("release tagging uses the protected workflow-capable token only at the release boundary", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /contents: read/);
  assert.match(
    workflow,
    /name: Create or verify release tag[\s\S]*?RELEASE_GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_GITHUB_TOKEN \}\}[\s\S]*?git push "https:\/\/x-access-token:\$\{RELEASE_GITHUB_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
  );
  assert.match(
    workflow,
    /name: Create GitHub Release[\s\S]*?GH_TOKEN: \$\{\{ secrets\.RELEASE_GITHUB_TOKEN \}\}/,
  );
});
