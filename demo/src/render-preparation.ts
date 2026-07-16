import type {
  RenderPreparationArtifactDiagnostics,
  RenderPreparationDiagnostics,
} from "supervision-js";

export function selectPreparedWindowArtifact(
  diagnostics: RenderPreparationDiagnostics | null,
): RenderPreparationArtifactDiagnostics | null {
  if (!diagnostics) {
    return null;
  }

  return (
    diagnostics.artifacts.find((artifact) => artifact.window !== undefined) ??
    diagnostics.artifacts[0] ??
    null
  );
}
