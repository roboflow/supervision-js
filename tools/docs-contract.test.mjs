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

test("every typed package subpath has a complete API facade", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "packages/web/package.json"), "utf8"),
  );
  const facadeBySubpath = new Map([
    [
      ".",
      [
        "detections.ts",
        // Editing types are intentionally dual-exported from the root and
        // the tree-shakeable editing subpath, so this one facade covers both.
        "editing.ts",
        "interactions.ts",
        "media-preparation.ts",
        "post-processing.ts",
        "rendering.ts",
        "sessions.ts",
        "styles.ts",
      ],
    ],
    ["./editing", ["editing.ts"]],
    ["./web-video-engine", ["video-engine.ts"]],
    ["./web-video-engine/analysis", ["video-engine-analysis.ts"]],
  ]);
  const sourceBySubpath = new Map([
    [".", "packages/web/src/index.ts"],
    ["./editing", "packages/web/src/editing.ts"],
    ["./web-video-engine", "packages/web/src/web-video-engine/index.ts"],
    ["./web-video-engine/analysis", "packages/video-engine/src/analysis.ts"],
  ]);
  const typedSubpaths = Object.entries(manifest.exports)
    .filter(
      ([, target]) =>
        typeof target === "object" && target !== null && "types" in target,
    )
    .map(([subpath]) => subpath)
    .sort();

  assert.deepEqual([...facadeBySubpath.keys()].sort(), typedSubpaths);

  for (const subpath of typedSubpaths) {
    const sourceExports = await readNamedExports(
      path.join(rootDir, sourceBySubpath.get(subpath)),
    );
    const documentedExports = new Set(
      (
        await Promise.all(
          facadeBySubpath
            .get(subpath)
            .map((facade) => readNamedExports(path.join(publicApiDir, facade))),
        )
      ).flat(),
    );

    assert.deepEqual(
      sourceExports.filter((name) => !documentedExports.has(name)).sort(),
      [],
      `${subpath} has exports missing from its TypeDoc facade`,
    );
  }
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
  assert.equal(
    packageReleaseStatus,
    packageJson.version.includes("-next.") ? "next preview" : "",
  );
});

const playbackGateSurfaces = [
  "packages/core/src/types/detection-timeline.ts",
  "packages/web/src/types/media-session.ts",
  "packages/web/src/types/render-preparation.ts",
  "docs/public/guides/detections-and-rendering.md",
  "docs/public/guides/media-preparation.md",
  "docs/public/guides/media-sessions.md",
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

test("every playback-gate surface states the default and reach the code ships", async () => {
  // Every gate reaches every frame on both source kinds, through different
  // mechanics. The default is read from the resolver rather than from a phrase,
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
  const namesThePulledPath =
    /pulls?\s+(?:a\s+)?(?:decoded\s+)?samples?|pulling\s+samples/i;
  /* A symbol name does not count. Naming the one implementation that presents
   * its own frames satisfied this check while saying nothing about the contract,
   * which is how an engine symbol came to sit in a core type that cannot even
   * resolve it. */
  const namesThePresentedPath =
    /presents?\s+its\s+own\s+frames|push-presented|presented-frame\s+channel/i;
  // A no-op claim is honest when it says which sources it is about and false
  // when it stands alone, so each claim is judged against its own sentence
  // rather than against the file.
  const scopesTheClaim = new RegExp(
    `${namesThePulledPath.source}|${namesThePresentedPath.source}`,
    "i",
  );
  const claimsNoGate = [
    /accepted and ignored/i,
    /(?:playback|presentation) (?:is )?never (?:gated|awaits|waits)/i,
  ];
  const claimsStartOnly =
    /holds? only the start of playback|held at the start of playback|holds? the start of playback and nothing after|held at the start only/i;
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
      !namesThePresentedPath.test(source)
    ) {
      failures.push(
        `${surface} never states which media sources the gate reaches`,
      );
    }

    for (const sentence of proseSentences(source)) {
      if (claimsStartOnly.test(sentence)) {
        failures.push(
          `${surface} documents a start-only gate, but both source kinds are gated at every frame`,
        );
      }

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

test("public installation guidance distinguishes stable and preview installs", async () => {
  const consumerDocs = [
    path.join(rootDir, "README.md"),
    path.join(publicDocsDir, "index.md"),
    path.join(publicDocsDir, "guides/application-integration.md"),
    path.join(publicDocsDir, "guides/public-api.md"),
  ];

  for (const file of consumerDocs) {
    const source = await readFile(file, "utf8");

    assert.match(source, /npm install supervision(?:\n|`|<)/);

    if (source.includes("supervision/web-video-engine")) {
      assert.match(source, /npm install supervision@next(?:\n|`|<)/);
    }
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
    "Web Video Engine",
    "Web Video Engine Analysis",
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

test("every renderer a docs page asks for is one the playground can build", async () => {
  const rendererModule = await readFile(
    path.join(rootDir, "demo/src/docs-annotation-renderer.ts"),
    "utf8",
  );
  const playgroundRouter = await readFile(
    path.join(
      rootDir,
      "demo/src/components/DocsAnnotationRendererPlayground.tsx",
    ),
    "utf8",
  );
  const pageRenderers = (
    await Promise.all(
      (await readdir(path.join(publicDocsDir, "annotation-renderers"))).map(
        (file) =>
          readFile(
            path.join(publicDocsDir, "annotation-renderers", file),
            "utf8",
          ),
      ),
    )
  ).flatMap(
    (page) =>
      page.match(/embed=annotation-renderer&amp;renderer=(?<id>[\w-]+)/)?.groups
        ?.id ?? [],
  );
  const declaredIds = [
    ...(rendererModule
      .match(
        /export const docsAnnotationRendererIds = \[(?<ids>[\s\S]*?)\] as const;/,
      )
      ?.groups?.ids.matchAll(/"(?<id>[^"]+)"/g) ?? []),
  ].map((match) => match.groups.id);
  const dedicatedPlaygrounds = [
    ...playgroundRouter.matchAll(/renderer === "(?<id>[^"]+)"/g),
  ].map((match) => match.groups.id);
  const snippetCases = [
    ...(rendererModule
      .match(
        /export function createDocsAnnotationRendererSnippet[\s\S]*?\n\}\n/,
      )?.[0]
      .matchAll(/case "(?<id>[^"]+)":/g) ?? []),
  ].map((match) => match.groups.id);

  assert.deepEqual([...pageRenderers].sort(), [...declaredIds].sort());

  for (const renderer of pageRenderers) {
    // parseDocsAnnotationRenderer falls back to boxes, so an id the demo does
    // not know renders the wrong playground rather than failing.
    assert.ok(
      dedicatedPlaygrounds.includes(renderer) ||
        snippetCases.includes(renderer),
      `${renderer} has neither a dedicated playground nor a live code snippet`,
    );
  }
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

test("display-feedback guidance uses session state across media providers", async () => {
  const mediaSessions = await readFile(
    path.join(publicDocsDir, "guides/media-sessions.md"),
    "utf8",
  );
  const reactRecipe = await readFile(
    path.join(publicDocsDir, "recipes/react-integration.md"),
    "utf8",
  );
  const publicApi = await readFile(
    path.join(publicDocsDir, "guides/public-api.md"),
    "utf8",
  );

  assert.match(
    reactRecipe,
    /session\.subscribe\(setSessionState\)[\s\S]*state\.renderer\?\.presentedTime/,
  );
  assert.match(publicApi, /subscribe to session state[\s\S]*presentedTime/);
  assert.doesNotMatch(
    reactRecipe,
    /renderer\.onFrame[\s\S]{0,120}presented timestamp/,
  );

  const feedback = findCodeBlocks(mediaSessions, "ts").find((source) =>
    source.includes('querySelector<HTMLOutputElement>("#displayed-time")'),
  );
  assert.ok(
    feedback,
    "Missing provider-independent playback feedback example.",
  );
  for (const field of [
    "presentedTime",
    "seeking",
    "scrubbing",
    "awaitingRead",
    "renderPreparationGateAbandoned",
  ])
    assert.ok(
      feedback.includes(field),
      `Missing playback feedback for ${field}`,
    );
  assertTypechecks(
    [
      'declare const session: import("supervision").MediaSession;',
      feedback,
    ].join("\n"),
    ".docs-playback-feedback.ts",
  );
});

test("the indexed frame-clock example typechecks", async () => {
  const guide = await readFile(
    path.join(publicDocsDir, "guides/media-sessions.md"),
    "utf8",
  );
  const example = findCodeBlocks(guide, "ts").find((source) =>
    source.includes("const clock = session.frameClock"),
  );
  assert.ok(example, "Missing indexed frame-clock example.");
  assertTypechecks(
    'export {};\ndeclare const session: import("supervision").MediaSession;\n' +
      example,
    ".docs-frame-clock.ts",
  );
});

test("the 0.2 interaction-style migration example typechecks", async () => {
  const migration = await readFile(
    path.join(publicDocsDir, "guides/migrating-to-0.2.md"),
    "utf8",
  );

  for (const removed of ["shape", "cornerRadius", "stroke", "fill"]) {
    assert.match(migration, new RegExp(`\\b${removed}\\b`));
  }

  const examples = findCodeBlocks(migration, "ts");
  const removedGate = examples.find((source) =>
    source.includes("minimumAheadSeconds"),
  );
  const after = examples.find((source) =>
    source.includes("const highlight = new BaseBoxStyle"),
  );
  assert.ok(removedGate, "Missing the removed playback-gate example.");
  assert.ok(after, "Missing the migrated BaseInteractionStyle example.");
  assertTypechecks(removedGate, ".docs-0.2-removed-gate.ts");
  assertTypechecks(after, ".docs-0.2-interaction-migration.ts");
});

test("the 0.1.7 upgrade documents both playback gates and added feedback", async () => {
  const migration = await readFile(
    path.join(publicDocsDir, "guides/migrating-to-0.2.md"),
    "utf8",
  );
  for (const field of [
    "minimumAheadSeconds",
    "requiredAheadSeconds",
    "stopBelowWallSeconds",
    "resumeMarginWallSeconds",
    "presentedTime",
    "drawnMaskFrameTime",
    "maskHeldStale",
    "playbackGateReach",
    "renderPreparationGateAbandoned",
    "seeking",
    "scrubbing",
    "awaitingRead",
    "frameClock",
    "frameNavigation",
    "setDisplay",
    "AbortError",
  ])
    assert.ok(
      migration.includes(field),
      `Missing upgrade guidance for ${field}`,
    );
  assert.match(migration, /ceiling/);
  assert.match(migration, /floor/);
  assert.match(migration, /maxWaitSeconds: 10/);
  assert.match(migration, /maxWaitSeconds: 2/);
  assert.match(migration, /maxWaitSeconds: Infinity/);
});

test("media-session streaming, frame navigation, and engine examples typecheck", async () => {
  const guide = await readFile(
    path.join(publicDocsDir, "guides/media-sessions.md"),
    "utf8",
  );
  const examples = findCodeBlocks(guide, "ts");
  const streaming = examples.find((source) =>
    source.includes("consumePredictions"),
  );
  const frameNavigation = examples.find((source) =>
    source.includes("navigation.moveToFrame"),
  );
  const drag = examples.find((source) => source.includes("finishTimelineDrag"));
  const appendable = examples.find(
    (source) =>
      source.includes("appendable: {") &&
      source.includes('datasetId: "camera-1"'),
  );
  const borrowedCleanup = examples.find((source) =>
    source.includes("source.destroy"),
  );
  const mountCleanup = examples.find(
    (source) =>
      source.includes("media: fileOrUrl") &&
      source.includes("function unmountViewer"),
  );
  const resize = examples.find((source) =>
    source.includes("const resizeOutput = session.setDisplay"),
  );
  const engine = examples.find((source) =>
    source.includes("createWebVideoEngineMediaRendererSource"),
  );
  const errors = examples.find((source) =>
    source.includes("showUnsupportedVideoMessage"),
  );

  for (const sourceShape of [
    "detections.frames",
    "detections.source",
    "detections.appendable",
    "detections.sources",
  ])
    assert.ok(
      guide.includes(sourceShape),
      `Missing source choice ${sourceShape}`,
    );
  assert.match(guide, /appendable[\s\S]{0,180}2 s[\s\S]{0,80}10 s/);
  assert.match(guide, /render-preparation gate[\s\S]{0,80}2 s/);
  assert.match(
    guide,
    /detection-coverage gate is on\s+by default for appendable detections and off for other detection inputs unless\s+explicitly enabled/,
  );
  assert.match(guide, /do not add a host\s+debounce/);
  assert.match(
    guide,
    /renderer\?\.seeking !== true \|\| renderer\.scrubbing === true/,
  );
  assert.match(frameNavigation ?? "", /moveToFrame\(nextFrame\)/);

  assert.ok(streaming, "Missing caller-owned streaming example.");
  assert.ok(frameNavigation, "Missing frame-navigation example.");
  assert.ok(drag, "Missing latest-wins drag termination example.");
  assert.ok(appendable, "Missing session-owned appendable example.");
  assert.ok(borrowedCleanup, "Missing borrowed-source cleanup example.");
  assert.ok(mountCleanup, "Missing session mount cleanup example.");
  assert.ok(resize, "Missing live output resize example.");
  assert.ok(engine, "Missing web video engine source example.");
  assert.ok(errors, "Missing media error example.");

  assertTypechecks(
    [
      "declare const container: HTMLElement;",
      "declare const media: string;",
      'declare const predictionFrames: AsyncIterable<import("supervision").DetectionFrame>;',
      streaming,
    ].join("\n"),
    ".docs-session-streaming.ts",
  );
  assertTypechecks(
    [
      "export {};",
      'declare const session: import("supervision").LiveMediaSession;',
      frameNavigation,
    ].join("\n"),
    ".docs-frame-navigation.ts",
  );
  assertTypechecks(
    [
      "export {};",
      'declare const session: import("supervision").LiveMediaSession;',
      drag,
    ].join("\n"),
    ".docs-frame-drag.ts",
  );
  assertTypechecks(
    [
      "declare const container: HTMLElement;",
      "declare const media: string;",
      appendable,
    ].join("\n"),
    ".docs-session-appendable.ts",
  );
  assertTypechecks(
    [
      'declare const session: import("supervision").LiveMediaSession;',
      "declare const source: { destroy(): void };",
      borrowedCleanup,
    ].join("\n"),
    ".docs-borrowed-source-cleanup.ts",
  );
  assertTypechecks(
    [
      "declare const container: HTMLElement;",
      "declare const fileOrUrl: string;",
      mountCleanup,
    ].join("\n"),
    ".docs-session-mount-cleanup.ts",
  );
  assertTypechecks(
    [
      'declare const session: import("supervision").LiveMediaSession;',
      "declare const container: HTMLElement;",
      "declare const maxDevicePixelRatio: number;",
      resize,
    ].join("\n"),
    ".docs-live-output-resize.ts",
  );
  assertTypechecks(
    ["declare const container: HTMLElement;", engine].join("\n"),
    ".docs-engine-source.ts",
  );
  assertTypechecks(
    [
      "declare const container: HTMLElement;",
      'declare const media: import("supervision").MediaSessionMedia;',
      "declare function showUnsupportedVideoMessage(): void;",
      "declare function showMediaOpenError(): void;",
      errors,
    ].join("\n"),
    ".docs-media-errors.ts",
  );
});

test("the documented drag finalizer cannot clear a newer gesture", async () => {
  const guide = await readFile(
    path.join(publicDocsDir, "guides/media-sessions.md"),
    "utf8",
  );
  const drag = findCodeBlocks(guide, "ts").find((source) =>
    source.includes("finishTimelineDrag"),
  );
  assert.ok(drag, "Missing latest-wins drag termination example.");

  const createRecipe = compileRecipe(drag);
  const firstMove = deferred();
  const secondMove = deferred();
  const scrubFailure = new Error("scrub failed");
  const reported = [];
  let move = 0;
  const session = {
    frameNavigation: {
      moveToTime() {
        move += 1;
        return move === 1 ? firstMove.promise : secondMove.promise;
      },
      scrubToTime(seconds) {
        return {
          target: { index: seconds, mediaTime: seconds, duration: 1 },
          settled:
            seconds === 2
              ? Promise.reject(scrubFailure)
              : Promise.resolve({ status: "superseded" }),
        };
      },
    },
    getState() {
      return { renderer: { currentTime: 9, presentedTime: 8 } };
    },
  };
  const recipe = createRecipe(session, {
    error(error) {
      reported.push(error);
    },
  });

  recipe.beginTimelineDrag();
  recipe.onTimelineMove(1);
  const oldFinalizer = recipe.onTimelinePointerUp(1);
  recipe.beginTimelineDrag();
  recipe.onTimelineMove(2);
  firstMove.reject(new globalThis.DOMException("superseded", "AbortError"));
  await oldFinalizer;
  await Promise.resolve();

  assert.equal(recipe.timelineKnobTime(), 2);
  assert.deepEqual(reported, [scrubFailure]);

  recipe.onTimelinePointerCancel(2);
  secondMove.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recipe.timelineKnobTime(), 8);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function compileRecipe(source) {
  const wrapped = `
    function createRecipe(session, console) {
      ${source}
      return {
        beginTimelineDrag,
        onTimelineMove,
        onTimelinePointerCancel,
        onTimelinePointerUp,
        timelineKnobTime,
      };
    }
  `;
  const compiled = ts.transpileModule(wrapped, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return Function(`${compiled}\nreturn createRecipe;`)();
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

test("bounded release recipes are complete and typecheck", async () => {
  const recipes = await Promise.all(
    ["timeline-scrubbing", "playing-video-file", "playback-state"].map(
      async (name) =>
        readFile(path.join(publicDocsDir, `recipes/${name}.md`), "utf8"),
    ),
  );
  const [scrub, video, state] = recipes.map(
    (source) => findCodeBlocks(source, "ts")[0],
  );
  assert.match(
    scrub,
    /pointerdown[\s\S]*pointermove[\s\S]*pointerup[\s\S]*pointercancel[\s\S]*lostpointercapture/,
  );
  assert.match(scrub, /frameClock[\s\S]*frameNavigation[\s\S]*showUnsupported/);
  assert.match(scrub, /lastTarget[\s\S]*pendingTarget/);
  assert.match(
    video,
    /SourceKind\.Blob[\s\S]*SourceKind\.Url[\s\S]*MediaErrorKind\.UnsupportedFormat/,
  );
  assert.match(
    state,
    /presentedTime[\s\S]*source\.awaitingRead[\s\S]*renderPreparationGateAbandoned/,
  );
  assertTypechecks(
    [
      'declare const session: import("supervision").LiveMediaSession;',
      scrub,
    ].join("\n"),
    ".docs-recipe-timeline.ts",
  );
  assertTypechecks([video].join("\n"), ".docs-recipe-video.ts");
  assertTypechecks(
    ['declare const session: import("supervision").MediaSession;', state].join(
      "\n",
    ),
    ".docs-recipe-state.ts",
  );
});

test("timeline recipe commits once, owns its pointer and protects newer gestures", async () => {
  const source = await readFile(
    path.join(publicDocsDir, "recipes/timeline-scrubbing.md"),
    "utf8",
  );
  const compiled = ts.transpileModule(findCodeBlocks(source, "ts")[0], {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  Function("exports", compiled)(exports);
  const timeline = new globalThis.EventTarget();
  const captures = new Set();
  const fire = (type, properties = {}) =>
    timeline.dispatchEvent(
      Object.assign(new globalThis.Event(type, { cancelable: true }), {
        button: 0,
        pointerId: 1,
        seconds: 1,
        ...properties,
      }),
    );
  timeline.focus = () => {};
  timeline.setPointerCapture = (id) => captures.add(id);
  timeline.hasPointerCapture = (id) => captures.has(id);
  timeline.releasePointerCapture = (id) => {
    captures.delete(id);
    fire("lostpointercapture", { pointerId: id });
  };
  const moves = [];
  const scrubs = [];
  const session = {
    frameClock: { timeAt: () => 0 },
    frameNavigation: {
      scrubToTime(seconds) {
        scrubs.push(seconds);
        return {
          target: { mediaTime: seconds },
          settled: Promise.resolve({ status: "superseded" }),
        };
      },
      moveToTime(seconds) {
        const move = { seconds, ...deferred() };
        moves.push(move);
        return move.promise;
      },
    },
    getState: () => ({ renderer: { presentedTime: 8 } }),
  };
  const control = exports.installTimelineScrubber(
    session,
    timeline,
    (event) => event.seconds,
    (event) => event.seconds,
    () => assert.fail("indexed source unexpectedly unsupported"),
  );
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  fire("pointerdown");
  fire("pointerdown", { pointerId: 2, seconds: 20 });
  fire("pointermove", { pointerId: 2, seconds: 21 });
  fire("pointerup", { pointerId: 2, seconds: 22 });
  assert.deepEqual(scrubs, [1]);
  assert.equal(moves.length, 0);
  fire("pointerup", { seconds: 2 });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].seconds, 2);
  assert.equal(captures.size, 0);
  fire("pointermove", { seconds: 9 });
  assert.equal(control.knobTime(), 2);
  moves[0].resolve();
  await flush();
  fire("lostpointercapture");
  fire("pointercancel");
  assert.equal(moves.length, 1);
  assert.equal(control.knobTime(), 8);

  fire("pointerdown", { seconds: 3 });
  fire("pointercancel", { seconds: 99 });
  assert.equal(moves[1].seconds, 3);
  fire("pointerdown", { seconds: 4 });
  moves[1].reject(new globalThis.DOMException("superseded", "AbortError"));
  await flush();
  assert.equal(control.knobTime(), 4);
  fire("lostpointercapture", { seconds: 99 });
  assert.equal(moves[2].seconds, 4);
  moves[2].resolve();
  await flush();

  for (const termination of ["keyup", "Enter", "Escape", "blur"]) {
    const before = moves.length;
    fire("keydown", { key: "ArrowRight", seconds: 5 });
    fire("keydown", { key: "ArrowRight", seconds: 6, repeat: true });
    assert.equal(control.knobTime(), 6);
    if (termination === "keyup") fire("keyup", { key: "ArrowRight" });
    else if (termination === "blur") fire("blur");
    else fire("keydown", { key: termination });
    fire("keyup", { key: "ArrowRight" });
    assert.equal(moves.length, before + 1);
    assert.equal(moves.at(-1).seconds, 6);
    moves.at(-1).resolve();
    await flush();
  }

  fire("pointerdown", { seconds: 7 });
  control.destroy();
  const count = moves.length;
  assert.equal(moves.at(-1).seconds, 7);
  assert.equal(captures.size, 0);
  fire("pointerdown", { seconds: 9 });
  fire("pointerup", { seconds: 9 });
  control.destroy();
  assert.equal(moves.length, count);
  moves.at(-1).resolve();
  await flush();
  assert.equal(control.knobTime(), 8);
  let unsupported = 0;
  assert.equal(
    exports.installTimelineScrubber(
      { ...session, frameClock: null },
      timeline,
      () => 0,
      () => 0,
      () => {
        unsupported += 1;
      },
    ),
    null,
  );
  assert.equal(unsupported, 1);
});

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
