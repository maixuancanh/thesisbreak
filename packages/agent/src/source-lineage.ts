import type { LineageEdge } from "../../domain/src/source-lineage";
export function normalizeReportUrl(raw: string) {
  const u = new URL(raw);
  for (const key of [...u.searchParams.keys()])
    if (
      key.startsWith("utm_") ||
      ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key)
    )
      u.searchParams.delete(key);
  u.hash = "";
  return u.toString();
}
export function groupVerifiedOrigins(
  evidence: { id: string; eventId: string; claimId: string }[],
  edges: LineageEdge[],
) {
  const parent = new Map(evidence.map((e) => [e.id, e.id]));
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const verified = new Set<string>();
  function root(id: string): string {
    let p = parent.get(id)!;
    while (p !== parent.get(p)) {
      p = parent.get(p)!;
    }
    return p;
  }
  for (const edge of edges) {
    const a = byId.get(edge.fromEvidenceId),
      b = byId.get(edge.toEvidenceId);
    if (
      edge.verification !== "verified" ||
      edge.relation === "correction_of" ||
      !a ||
      !b ||
      a.eventId !== b.eventId ||
      a.claimId !== b.claimId
    )
      continue;
    const x = root(a.id),
      y = root(b.id);
    const canonical = x < y ? x : y;
    parent.set(x, canonical);
    parent.set(y, canonical);
    verified.add(a.id);
    verified.add(b.id);
  }
  const families = new Map<string, string[]>();
  for (const e of evidence) {
    const k = root(e.id);
    families.set(k, [...(families.get(k) ?? []), e.id]);
  }
  return {
    families: [...families].map(([id, evidenceIds]) => ({
      id,
      evidenceIds,
      originStatus: evidenceIds.some((id) => verified.has(id))
        ? ("verified" as const)
        : ("unknown" as const),
    })),
    confirmedIndependentCount: 0,
    unknownCount: evidence.filter((e) => !verified.has(e.id)).length,
    methodologyVersion: "verified-report-edges-v1",
  };
}
