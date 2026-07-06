import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(
  __dirname,
  "../ios/supervisionjsRN.xcodeproj/project.pbxproj",
);

const generatedOutputLine =
  '\t\t\t\t"$(SRCROOT)/Pods/Target Support Files/Pods-supervisionjsRN/ExpoModulesProvider.swift",';

const project = await readFile(projectPath, "utf8");
let patched = project.replace(`${generatedOutputLine}\n`, "");

// Expo 56 skips `-allowProvisioningUpdates` when DEVELOPMENT_TEAM already
// exists in the generated project. Removing it before `expo run:ios` makes
// Expo re-resolve the team and pass the provisioning flags needed for fresh
// physical-device installs.
patched = patched.replaceAll(/\n\s*DEVELOPMENT_TEAM = [^;]+;/g, "");

if (patched === project) {
  console.log("Expo Xcode project patch already applied.");
} else {
  await writeFile(projectPath, patched);
  console.log(
    "Patched Expo Xcode project outputs and device signing bootstrap.",
  );
}
