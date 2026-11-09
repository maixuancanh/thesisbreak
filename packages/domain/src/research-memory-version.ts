import { createHash } from "node:crypto";
import type { MemoryRecord } from "../../integrations/src/memwal";
export type ResearchArtifactKind =
  | "source_change"
  | "forecast_rationale"
  | "forecast_result"
  | "drift_summary"
  | "decision_recap"
  | "accountability_review";
export function canonicalResearchMemory(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalResearchMemory).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalResearchMemory(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const researchArtifactHash = (value: unknown) =>
  createHash("sha256").update(canonicalResearchMemory(value)).digest("hex");
export function researchMemoryBytes(
  ownerId: string,
  record: MemoryRecord,
): string {
  const body = { schema: 1, userId: ownerId, ...record };
  return canonicalResearchMemory({ ...body, hash: researchArtifactHash(body) });
}
export function researchMemoryHash(
  ownerId: string,
  record: MemoryRecord,
): string {
  return researchArtifactHash({ schema: 1, userId: ownerId, ...record });
}
export interface ResearchArtifactSnapshot {
  kind: ResearchArtifactKind;
  artifactId: string;
  logicalId: string;
  version: number;
  snapshot: Record<string, unknown>;
}
export function buildResearchMemoryRecord(
  ownerId: string,
  artifact: ResearchArtifactSnapshot,
  recordedAt: string,
): MemoryRecord {
  if (
    !ownerId ||
    !Number.isInteger(artifact.version) ||
    artifact.version < 1 ||
    !Number.isFinite(Date.parse(recordedAt))
  )
    throw Error("INVALID_RESEARCH_MEMORY");
  return {
    logicalId: artifact.logicalId,
    version: artifact.version,
    type: `research_${artifact.kind}`,
    recordedAt,
    payload: JSON.parse(
      JSON.stringify({
        userId: ownerId,
        ...(artifact.kind === "decision_recap" ||
        artifact.kind === "accountability_review"
          ? {
              schemaVersion: artifact.kind === "accountability_review" ? 3 : 2,
              namespace: `owner:${ownerId}`,
              mode: artifact.snapshot.mode,
              lineageVersion: "verified-lineage-v1",
              predecessor: artifact.snapshot.predecessor_id ?? null,
            }
          : {}),
        scope: "research_artifact",
        kind: artifact.kind,
        artifactId: artifact.artifactId,
        snapshotHash: researchArtifactHash(artifact.snapshot),
        snapshot: artifact.snapshot,
      }),
    ),
  };
}
