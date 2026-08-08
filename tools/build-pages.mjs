import { spawn } from "node:child_process";
import process from "node:process";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDirectory = resolve(projectRoot, "dist/pages");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
// Relative asset URLs let the same static artifact work at the root of a
// custom domain (Render) and below a project prefix (GitHub Pages).
const staticAppBasePath = "./";

await main();

async function main() {
  await rm(pagesDirectory, { force: true, recursive: true });

  await runNpm(["run", "build"]);
  await runNpm(["run", "build", "-w", "demo"], {
    VITE_DEMO_ALLOW_UPLOAD: "false",
    VITE_DEMO_BASE_PATH: staticAppBasePath,
  });
  await runNpm(["run", "build", "-w", "examples/vanilla"], {
    VITE_VANILLA_BASE_PATH: staticAppBasePath,
  });
  await runNpm(["run", "docs:build:typedoc"]);

  await copyDirectoryContents(
    resolve(projectRoot, "docs/site"),
    pagesDirectory,
  );
  await copyDirectoryContents(
    resolve(projectRoot, "demo/dist"),
    join(pagesDirectory, "demo"),
  );
  await copyDirectoryContents(
    resolve(projectRoot, "examples/vanilla/dist"),
    join(pagesDirectory, "examples/vanilla"),
  );
  await writeFile(join(pagesDirectory, ".nojekyll"), "");

  await verifyPagesArtifact();
  console.log(`GitHub Pages artifact ready at ${pagesDirectory}.`);
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });

  for (const entry of await readdir(source)) {
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
    });
  }
}

async function verifyPagesArtifact() {
  const requiredFiles = [
    "index.html",
    "demo/index.html",
    "examples/vanilla/index.html",
  ];

  await Promise.all(
    requiredFiles.map((file) => access(join(pagesDirectory, file))),
  );

  const generatedHtml = await Promise.all(
    ["demo/index.html", "examples/vanilla/index.html"].map((file) =>
      readFile(join(pagesDirectory, file), "utf8"),
    ),
  );

  if (generatedHtml.some((html) => html.includes("/supervision-js/"))) {
    throw new Error(
      "GitHub Pages artifact contains a /supervision-js/ asset prefix, but this deployment is served from the domain root.",
    );
  }

  if (
    generatedHtml.some((html) =>
      /(?:src|href)="\/(?:demo|examples)\//.test(html),
    )
  ) {
    throw new Error(
      "Static application assets must use relative URLs so the artifact works under a project URL prefix.",
    );
  }
}

function runNpm(arguments_, environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCommand, arguments_, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(`npm ${arguments_.join(" ")} exited with ${exitCode}.`),
      );
    });
  });
}
