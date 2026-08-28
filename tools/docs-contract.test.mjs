import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import ts from "typescript";

import {
  checkChecksums,
  checkCommentFlags,
  checkDeclaredFlags,
  checkExports,
  checkNpmScripts,
  checkPaths,
  checkScriptFlags,
  checkVersions,
  loadDocuments,
  loadRepository,
  loadSources,
} from "./docs-claims.mjs";

const rootDir = process.cwd();
const publicDocsDir = path.join(rootDir, "docs/public");
const publicApiDir = path.join(publicDocsDir, "api");

test("Markdown links resolve inside the repository", async () => {
  const { documents } = await documentation();
  const failures = [];

  for (const { file, source } of documents) {
    for (const target of findMarkdownLinks(source)) {
      if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue;
      }

      const pathname = decodeURIComponent(target.split("#", 1)[0]);

      if (!pathname) {
        continue;
      }

      const resolved = path.resolve(path.dirname(file), pathname);

      try {
        await stat(resolved);
      } catch {
        failures.push(
          `${path.relative(rootDir, file)} links to missing ${target}`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("generated API facades cover every browser package export", async () => {
  const packageExports = await readNamedExports(
    path.join(rootDir, "packages/web/src/index.ts"),
  );
  const documentedExports = new Set(
    (
      await Promise.all(
        (await listFiles(publicApiDir, ".ts")).map(readNamedExports),
      )
    ).flat(),
  );

  assert.deepEqual(
    packageExports.filter((name) => !documentedExports.has(name)).sort(),
    [],
  );
});

test("Editing API facade covers every editing subpath export", async () => {
  const editingExports = await readNamedExports(
    path.join(rootDir, "packages/web/src/editing.ts"),
  );
  const documentedExports = new Set(
    await readNamedExports(path.join(publicApiDir, "editing.ts")),
  );

  assert.deepEqual(
    editingExports.filter((name) => !documentedExports.has(name)).sort(),
    [],
  );
});

test("TypeDoc includes every public API facade", async () => {
  const config = JSON.parse(
    await readFile(path.join(rootDir, "typedoc.json"), "utf8"),
  );
  const configured = new Set(
    config.entryPoints.map((entryPoint) => path.resolve(rootDir, entryPoint)),
  );
  const apiFiles = await listFiles(publicApiDir, ".ts");

  assert.deepEqual(
    apiFiles
      .filter((file) => !configured.has(file))
      .map((file) => path.relative(rootDir, file))
      .sort(),
    [],
  );
});

test("TypeDoc does not publish the private workspace version", async () => {
  const config = JSON.parse(
    await readFile(path.join(rootDir, "typedoc.json"), "utf8"),
  );

  assert.equal(config.includeVersion, false);
});

test("documentation toolbar mirrors the browser package manifest version", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "packages/web/package.json"), "utf8"),
  );
  const toolbarScript = await readFile(
    path.join(publicDocsDir, "typedoc-icons.js"),
    "utf8",
  );
  const packageName = toolbarScript.match(
    /const packageName = "([^"]+)";/,
  )?.[1];
  const packageVersion = toolbarScript.match(
    /const packageVersion = "([^"]+)";/,
  )?.[1];
  const packageReleaseStatus = toolbarScript.match(
    /const packageReleaseStatus = "([^"]*)";/,
  )?.[1];

  assert.equal(packageName, packageJson.name);
  assert.equal(packageVersion, packageJson.version);
  assert.equal(packageReleaseStatus, "");
});

const playbackGateSurfaces = [
  "packages/core/src/types/detection-timeline.ts",
  "packages/web/src/types/media-session.ts",
  "packages/web/src/types/render-preparation.ts",
  "docs/public/recipes/multiple-detection-sources.md",
  "docs/public/recipes/streaming-detections.md",
];

/**
 * Splits prose into sentences so a claim can be judged against the qualifier
 * standing next to it. Comment leaders and Markdown bullets are stripped first
 * and the split needs whitespace after the terminator, so `session.play` and
 * `detections.playbackGate` survive it intact.
 */
function proseSentences(source) {
  return source
    .replace(/^[ \t]*(?:\/\*\*|\*\/|\*|\/\/|[-*+]|#+)[ \t]?/gm, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.;:])\s+/);
}

test("every playback-gate surface states the default the code ships", async () => {
  // The gate holds a producer that owns its own playhead only at the start of
  // playback, so every surface that names it has to say which sources it
  // reaches. The default is read from the resolver rather than from a phrase,
  // because a surface can name a scope and still describe the wrong default.
  const defaultsSource = await readFile(
    path.join(rootDir, "packages/web/src/sessions/media-session-defaults.ts"),
    "utf8",
  );
  const readsGateEnabled = (constantName) => {
    const match = new RegExp(
      `const ${constantName} = \\{[^}]*?enabled: (true|false)`,
      "s",
    ).exec(defaultsSource);

    assert.ok(match, `${constantName} no longer declares an enabled default`);

    return match[1] === "true";
  };
  const gateShipsOn =
    readsGateEnabled("DETECTION_PLAYBACK_GATE_DEFAULTS") &&
    readsGateEnabled("RENDER_PREPARATION_PLAYBACK_GATE_DEFAULTS");
  const namesTheGate = /playbackGate|playback gate/;
  // Prose is reflowed to a column, so a stated default can straddle a line
  // break and a naive pattern would miss it.
  const statesTheDefault = gateShipsOn
    ? /on\s+by\s+default|holds[\s\S]{0,120}?by\s+default/i
    : /off\s+by\s+default|off\s+unless|the gate off, which is the default/i;
  const namesThePulledPath = /pulls? (?:decoded )?samples|pulling samples/i;
  const namesTheExemptSource =
    /presents? its own frames|push-presented|presented-frame channel|VideoEngineMediaSource|VideoEngineMediaRendererSource/i;
  // A no-op claim is honest when it says which sources it is about and false
  // when it stands alone, so each claim is judged against its own sentence
  // rather than against the file.
  const scopesTheClaim = new RegExp(
    `${namesThePulledPath.source}|${namesTheExemptSource.source}`,
    "i",
  );
  const claimsNoGate = [
    /accepted and ignored/i,
    /(?:playback|presentation) (?:is )?never (?:gated|awaits|waits)/i,
  ];
  const failures = [];

  for (const surface of playbackGateSurfaces) {
    const source = await readFile(path.join(rootDir, surface), "utf8");

    if (!namesTheGate.test(source)) {
      failures.push(`${surface} never names the playback gate`);
    }

    if (!statesTheDefault.test(source)) {
      failures.push(
        `${surface} never states that the gate ships ${gateShipsOn ? "on" : "off"} by default`,
      );
    }

    if (
      !namesThePulledPath.test(source) ||
      !namesTheExemptSource.test(source)
    ) {
      failures.push(
        `${surface} never states which media sources the gate reaches`,
      );
    }

    for (const sentence of proseSentences(source)) {
      if (
        claimsNoGate.some((claim) => claim.test(sentence)) &&
        !scopesTheClaim.test(sentence)
      ) {
        failures.push(
          `${surface} documents the gate as a no-op everywhere, which it is not`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("public installation guidance uses the stable browser package", async () => {
  const consumerDocs = [
    path.join(rootDir, "README.md"),
    path.join(publicDocsDir, "index.md"),
    path.join(publicDocsDir, "guides/application-integration.md"),
    path.join(publicDocsDir, "guides/public-api.md"),
  ];

  for (const file of consumerDocs) {
    const source = await readFile(file, "utf8");

    assert.match(source, /npm install supervision(?:\n|`|<)/);
    assert.doesNotMatch(source, /npm install supervision@/);
  }
});

test("the docs home embeds the local basketball playground", async () => {
  const homepage = await readFile(path.join(publicDocsDir, "index.md"), "utf8");
  const toolbarScript = await readFile(
    path.join(publicDocsDir, "typedoc-icons.js"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  );

  assert.match(
    homepage,
    /data-supervision-playground-src="demo\/\?embed=docs-playground"/,
  );
  assert.match(
    homepage,
    /href="documents\/Annotation_Renderers\.html">Annotation renderers</,
  );
  assert.match(homepage, /aria-label="Documentation entry points"/);
  assert.match(homepage, /title="Interactive basketball detection playground"/);
  assert.match(
    toolbarScript,
    /window\.location\.port === "5175"[\s\S]*?http:\/\/127\.0\.0\.1:5173\//,
  );
  assert.equal(packageJson.scripts["docs:dev"], "npm run dev:demo-docs");
});

test("TypeDoc presents public guidance as five navigable sections", async () => {
  const config = JSON.parse(
    await readFile(path.join(rootDir, "typedoc.json"), "utf8"),
  );

  assert.deepEqual(config.projectDocuments, [
    "docs/public/getting-started.md",
    "docs/public/concepts.md",
    "docs/public/annotation-renderers.md",
    "docs/public/post-processors.md",
    "docs/public/recipes.md",
  ]);
  assert.deepEqual(config.sort, ["documents-first", "source-order"]);
  assert.equal(config.sortEntryPoints, false);
  assert.deepEqual(config.navigationLeaves, [
    "Detections",
    "Editing",
    "Interactions",
    "Media Preparation",
    "Post Processing",
    "Media Sessions",
    "Rendering",
    "Styles",
  ]);
});

test("tracking post processing has a focused live playground", async () => {
  const index = await readFile(
    path.join(publicDocsDir, "post-processors.md"),
    "utf8",
  );
  const tracking = await readFile(
    path.join(publicDocsDir, "post-processors", "tracking.md"),
    "utf8",
  );
  const demoApp = await readFile(
    path.join(rootDir, "demo/src/App.tsx"),
    "utf8",
  );
  const playground = await readFile(
    path.join(
      rootDir,
      "demo/src/components/DocsTrackingPostProcessorPlayground.tsx",
    ),
    "utf8",
  );

  assert.match(index, /post-processors\/tracking\.md/);
  assert.match(
    tracking,
    /data-supervision-playground-src="demo\/\?embed=post-processor&amp;processor=tracking"/,
  );
  assert.match(tracking, /createDetectionPostProcessingPipeline/);
  assert.match(tracking, /detectionPostProcessors\.tracking/);
  assert.match(tracking, /maxPendingFrames/);
  assert.match(demoApp, /DocsTrackingPostProcessorPlayground/);
  assert.match(playground, /Track detections/);
  assert.match(playground, /Show raw detections/);
  assert.match(playground, /Tracked detections/);
  assert.match(playground, /RETRACK_DEBOUNCE_MS/);
  assert.match(playground, /Ordered \{trackingAlgorithmLabel\(algorithm\)\}/);
  assert.match(playground, /<option value="bytetrack">ByteTrack<\/option>/);
  assert.match(playground, /<option value="cbiou">C-BIoU<\/option>/);
  assert.match(playground, /<option value="ocsort">OC-SORT<\/option>/);
  assert.match(playground, /const resumeTime = demo\.getCurrentTime\(\)/);
  assert.match(playground, /demo\.pausePlayback\(\)/);
  assert.match(playground, /await demo\.onSeek\(resumeTime\)/);
  assert.match(
    playground,
    /setStatus\("tracked"\);\s*await demo\.playPlayback\(\)/,
  );
  assert.doesNotMatch(playground, /Apply tracking/);

  const styles = await readFile(
    path.join(rootDir, "demo/src/styles.css"),
    "utf8",
  );
  const chipRule = styles.match(
    /\.docs-tracking-playground__badge\s*\{(?<rule>[^}]*)\}/,
  )?.groups?.rule;

  assert.match(chipRule ?? "", /left:\s*1rem/);
  assert.match(chipRule ?? "", /top:\s*1rem/);
  assert.doesNotMatch(chipRule ?? "", /transform:/);
});

test("every fixture-backed annotation renderer has a focused live playground", async () => {
  const renderers = [
    "boxes",
    "box-corners",
    "ellipse",
    "masks",
    "labels",
    "mask-halo",
    "markers",
    "polygons",
    "polylines",
    "keypoints",
    "regions",
    "region-effects",
  ];
  const pages = {
    boxes: "boxes.md",
    "box-corners": "box-corners.md",
    ellipse: "ellipse.md",
    keypoints: "keypoints-and-skeletons.md",
    labels: "labels.md",
    "mask-halo": "mask-halo.md",
    markers: "markers.md",
    masks: "masks.md",
    polygons: "polygons.md",
    polylines: "polylines.md",
    regions: "asset-regions.md",
    "region-effects": "region-effects.md",
  };
  const factories = {
    boxes: "box",
    "box-corners": "boxCorners",
    ellipse: "ellipse",
    keypoints: "keypoints",
    labels: "label",
    "mask-halo": "maskHalo",
    markers: "marker",
    masks: "mask",
    polygons: "polygon",
    polylines: "polyline",
    regions: "region",
    "region-effects": "region",
  };
  const annotationRendererIndex = await readFile(
    path.join(publicDocsDir, "annotation-renderers.md"),
    "utf8",
  );
  const toolbarScript = await readFile(
    path.join(publicDocsDir, "typedoc-icons.js"),
    "utf8",
  );
  const docsCss = await readFile(
    path.join(publicDocsDir, "typedoc-custom.css"),
    "utf8",
  );

  for (const renderer of renderers) {
    const page = await readFile(
      path.join(publicDocsDir, "annotation-renderers", pages[renderer]),
      "utf8",
    );

    assert.match(
      page,
      new RegExp(
        `data-supervision-playground-src="demo/\\?embed=annotation-renderer&amp;renderer=${renderer}"`,
      ),
    );
    assert.match(page, /session\.setPresentation\(\{/);
    assert.match(
      page,
      new RegExp(`annotationRenderers\\.${factories[renderer]}\\(`),
    );
    assert.match(annotationRendererIndex, new RegExp(pages[renderer]));
  }

  assert.match(toolbarScript, /iframe\[data-supervision-playground-src\]/);
  assert.match(
    toolbarScript,
    /const base = document\.documentElement\.dataset\.base \?\? "\.\/";[\s\S]*?new URL\(`\$\{base\}\$\{deployedPath\}`/,
  );
  assert.match(toolbarScript, /supervision-js:playground-height/);
  assert.match(toolbarScript, /api-reference/);
  assert.match(
    toolbarScript,
    /const details = document\.createElement\("details"\)/,
  );
  assert.match(toolbarScript, /label\.textContent = "API Reference"/);
  assert.match(
    docsCss,
    /supervision-docs--home-layout \{[\s\S]*?min-height: 0 !important;[\s\S]*?position: static !important;[\s\S]*?transform: none !important;/,
  );
  assert.match(
    docsCss,
    /supervision-docs--home-layout > \.col-sidebar \{[\s\S]*?align-self: start;[\s\S]*?min-height: 0 !important;/,
  );
  assert.match(
    docsCss,
    /container-main:not\(\.supervision-docs--home-layout\) \{[\s\S]*?grid-template-areas: "sidebar content" !important;[\s\S]*?grid-template-columns: minmax\(13rem, 15rem\) minmax\(0, 1fr\) !important;/,
  );
  assert.match(
    docsCss,
    /container-main:not\(\.supervision-docs--home-layout\) \.page-menu \{[\s\S]*?display: none !important;/,
  );
  assert.match(
    docsCss,
    /\.tsd-typography:has\(\.supervision-layer-playground\) \{[\s\S]*?max-width: 72rem;/,
  );
});

test("Render preview trusts only its assigned hostname", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  );
  const serveCommand = packageJson.scripts["pages:serve"];

  assert.match(
    serveCommand,
    /__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=\$\{RENDER_EXTERNAL_HOSTNAME:-supervision-js-demo\.onrender\.com\}/,
  );
  assert.doesNotMatch(serveCommand, /allowedHosts=(?:true|\*)/);
});

test("deployed site presents docs at the root and the workbench at /demo/", async () => {
  const pagesBuild = await readFile(
    path.join(rootDir, "tools/build-pages.mjs"),
    "utf8",
  );
  const demoApp = await readFile(
    path.join(rootDir, "demo/src/App.tsx"),
    "utf8",
  );
  const docsUrl = await readFile(
    path.join(rootDir, "demo/src/docs-url.ts"),
    "utf8",
  );
  const homepage = await readFile(path.join(publicDocsDir, "index.md"), "utf8");
  const toolbar = await readFile(
    path.join(publicDocsDir, "typedoc-icons.js"),
    "utf8",
  );

  assert.match(pagesBuild, /const staticAppBasePath = "\.\/";/);
  assert.match(pagesBuild, /VITE_DEMO_BASE_PATH: staticAppBasePath/);
  assert.match(pagesBuild, /VITE_VANILLA_BASE_PATH: staticAppBasePath/);
  assert.match(
    pagesBuild,
    /resolve\(projectRoot, "docs\/site"\),\n {4}pagesDirectory/,
  );
  assert.match(
    pagesBuild,
    /resolve\(projectRoot, "demo\/dist"\),\n {4}join\(pagesDirectory, "demo"\)/,
  );
  assert.match(pagesBuild, /"demo\/index\.html"/);
  assert.doesNotMatch(pagesBuild, /"docs\/index\.html"/);
  assert.match(demoApp, /resolveDemoDocsUrl\(/);
  assert.match(docsUrl, /return new URL\("\.\.\/", location\.href\)\.href/);
  assert.match(homepage, /data-supervision-demo-link href="demo\/"/);
  assert.match(
    homepage,
    /data-supervision-playground-src="demo\/\?embed=docs-playground"/,
  );
  assert.match(toolbar, /function resolveDemoUrl\(deployedPath\)/);
  // resolveDemoUrl() prefixes data-base itself, so a call site that also
  // interpolates the base applies it twice. That resolves above the project
  // prefix on nested pages and sends the deployed link to /demo/.
  assert.doesNotMatch(toolbar, /resolveDemoUrl\(`\$\{base\}/);
});

test("copyable integration examples typecheck", async () => {
  const homepage = await readFile(path.join(publicDocsDir, "index.md"), "utf8");
  const applicationGuide = await readFile(
    path.join(publicDocsDir, "guides/application-integration.md"),
    "utf8",
  );
  const reactRecipe = await readFile(
    path.join(publicDocsDir, "recipes/react-integration.md"),
    "utf8",
  );
  const browserExample = findCodeBlocks(applicationGuide, "ts").find((source) =>
    source.includes("let session: MediaSession"),
  );
  const reactExample = findCodeBlocks(reactRecipe, "tsx")[0];
  const homepageExample = findHtmlCodeBlock(homepage, "language-ts");

  assert.ok(browserExample, "Missing minimal browser integration example.");
  assert.ok(reactExample, "Missing React integration example.");
  assert.ok(homepageExample, "Missing homepage quick-start example.");
  assertTypechecks(homepageExample, ".docs-homepage-integration.ts");
  assertTypechecks(browserExample, ".docs-browser-integration.ts");
  assertTypechecks(
    reactExample,
    ".docs-react-integration.tsx",
    ts.JsxEmit.ReactJSX,
  );
});

test("every path a document names exists", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkPaths(repository, documents), []);
});

test("every npm script a document runs is declared", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkNpmScripts(repository, documents), []);
});

test("every flag a document shows is one its script reads", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkScriptFlags(repository, documents), []);
});

test("every flag a script declares is one the document beside it shows", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkDeclaredFlags(repository, documents), []);
});

test("every checksum a document quotes matches the file beside it", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkChecksums(repository, documents), []);
});

test("every version a document states matches the package manifest", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkVersions(repository, documents), []);
});

test("every symbol a document imports is exported", async () => {
  const { repository, documents } = await documentation();

  assert.deepEqual(await checkExports(repository, documents), []);
});

test("every path a comment or manifest script names exists", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkPaths(repository, sources), []);
});

test("every npm script a comment or manifest script runs is declared", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkNpmScripts(repository, sources), []);
});

test("every flag a manifest script passes is one its script reads", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkScriptFlags(repository, sources), []);
});

test("every flag a script's own comments show is one it reads", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkCommentFlags(repository, sources), []);
});

test("every checksum a comment quotes matches the file beside it", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkChecksums(repository, sources), []);
});

test("every version a comment states matches the package manifest", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkVersions(repository, sources), []);
});

test("every subpath a comment imports is exported", async () => {
  const { repository, sources } = await commentary();

  assert.deepEqual(await checkExports(repository, sources), []);
});

let corpus;
let commentCorpus;

function documentation() {
  corpus ??= (async () => {
    const repository = await loadRepository(rootDir);

    return { documents: await loadDocuments(repository), repository };
  })();

  return corpus;
}

function commentary() {
  commentCorpus ??= (async () => {
    const { repository } = await documentation();

    return { repository, sources: await loadSources(repository) };
  })();

  return commentCorpus;
}

function findMarkdownLinks(source) {
  return [...source.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .filter((match) => !match[0].startsWith("!"))
    .map((match) => match[1]);
}

function findHtmlCodeBlock(source, className) {
  const match = source.match(
    new RegExp(`<pre><code class="${className}">([\\s\\S]*?)<\\/code><\\/pre>`),
  );

  return match?.[1]
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function findCodeBlocks(source, language) {
  return [
    ...source.matchAll(
      new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```", "g"),
    ),
  ].map((match) => match[1]);
}

async function listFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listFiles(entryPath, extension);
      }

      return entry.isFile() && entry.name.endsWith(extension)
        ? [entryPath]
        : [];
    }),
  );

  return files.flat().sort();
}

async function readNamedExports(file) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [];

  source.forEachChild((node) => {
    if (
      !ts.isExportDeclaration(node) ||
      !node.exportClause ||
      !ts.isNamedExports(node.exportClause)
    ) {
      return;
    }

    for (const element of node.exportClause.elements) {
      names.push(element.name.text);
    }
  });

  return names;
}

function assertTypechecks(source, filename, jsx) {
  const file = path.resolve(rootDir, filename);
  const options = {
    jsx,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const readSourceFile = host.readFile.bind(host);

  host.fileExists = (candidate) => candidate === file || fileExists(candidate);
  host.readFile = (candidate) =>
    candidate === file ? source : readSourceFile(candidate);
  host.getSourceFile = (candidate, languageVersion, ...rest) =>
    candidate === file
      ? ts.createSourceFile(
          candidate,
          source,
          languageVersion,
          true,
          jsx === undefined ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
        )
      : getSourceFile(candidate, languageVersion, ...rest);

  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([file], options, host),
  );

  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );
}
