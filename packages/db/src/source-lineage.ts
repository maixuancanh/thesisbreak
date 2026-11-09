import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  lineageEdgeSchema,
  type LineageEdge,
} from "../../domain/src/source-lineage";
import { groupVerifiedOrigins } from "../../agent/src/source-lineage";
import { monitoringTransaction } from "./pick-reasons";
export async function recordSourceLineage(
  pool: Pool,
  userId: string,
  input: LineageEdge,
) {
  const edge = lineageEdgeSchema.parse(input);
  return monitoringTransaction(pool, userId, async (c) => {
    if (edge.verification === "verified") {
      const refs = (
        await c.query(
          "SELECT id,url,snapshot_hash,snapshot_value FROM source_watches WHERE user_id=$1 AND id=ANY($2::text[]) FOR SHARE",
          [userId, [edge.fromEvidenceId, edge.toEvidenceId]],
        )
      ).rows;
      const from = refs.find((r) => r.id === edge.fromEvidenceId),
        to = refs.find((r) => r.id === edge.toEvidenceId);
      if (!from || !to) throw Error("LINEAGE_EVIDENCE_NOT_OWNED");
      if (
        edge.supportHash !== from.snapshot_hash ||
        ![from.id, from.url].includes(edge.supportRef)
      )
        throw Error("LINEAGE_SUPPORT_MISMATCH");
      if (
        edge.relation === "explicit_citation" ||
        edge.relation === "correction_of"
      ) {
        if (!from.snapshot_value?.includes(to.url))
          throw Error("LINEAGE_CITATION_MISSING");
      } else {
        let a: unknown, b: unknown;
        try {
          a = JSON.parse(from.snapshot_value);
          b = JSON.parse(to.snapshot_value);
        } catch {
          throw Error("LINEAGE_REPORT_ID_MISSING");
        }
        if (
          !a ||
          !b ||
          typeof a !== "object" ||
          typeof b !== "object" ||
          !("reportId" in a) ||
          !("reportId" in b) ||
          typeof a.reportId !== "string" ||
          a.reportId.length === 0 ||
          a.reportId !== b.reportId
        )
          throw Error("LINEAGE_REPORT_ID_MISMATCH");
      }
    }
    await c.query(
      "INSERT INTO source_lineage_edges(id,user_id,from_evidence_id,to_evidence_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        edge.id ?? randomUUID(),
        userId,
        edge.fromEvidenceId,
        edge.toEvidenceId,
        JSON.stringify(edge),
      ],
    );
    return edge;
  });
}
export async function listSharedReasons(pool: Pool, userId: string) {
  return monitoringTransaction(pool, userId, async (c) => {
    const rows = (
      await c.query(
        "SELECT DISTINCT w.id,w.url,w.event_id,w.dependency_id,w.structured_evidence,r.pick_id,r.id AS reason_id FROM pick_watch_bindings b JOIN pick_reason_versions r ON r.id=b.reason_id AND r.user_id=b.user_id JOIN picks p ON p.id=r.pick_id AND p.user_id=r.user_id AND p.current_version=r.pick_version JOIN source_watches w ON w.id=b.watch_id AND w.user_id=b.user_id WHERE b.user_id=$1 AND b.state='active' AND w.state='active' AND w.expires_at>clock_timestamp()",
        [userId],
      )
    ).rows;
    const evidence = [
      ...new Map(
        rows.map((r) => [
          r.id,
          {
            id: r.id,
            eventId: r.event_id,
            claimId: r.structured_evidence?.claimId ?? r.dependency_id,
          },
        ]),
      ).values(),
    ];
    const edges = (
      await c.query(
        "SELECT e.payload FROM source_lineage_edges e JOIN source_watches w ON w.id=e.from_evidence_id AND w.user_id=e.user_id AND w.snapshot_hash=e.payload->>'supportHash' WHERE e.user_id=$1",
        [userId],
      )
    ).rows.map((r) => lineageEdgeSchema.parse(r.payload));
    const groups = groupVerifiedOrigins(evidence, edges);
    return {
      items: groups.families
        .map((g) => {
          const matches = rows.filter((r) => g.evidenceIds.includes(r.id));
          const pickIds = [...new Set(matches.map((r) => r.pick_id as string))];
          return {
            familyId: g.id,
            originStatus: g.originStatus,
            sourceUrl: matches[0]?.url ?? null,
            pickIds,
            pickCount: pickIds.length,
            reasonIds: [...new Set(matches.map((r) => r.reason_id as string))],
          };
        })
        .filter((g) => g.pickCount > 1),
      methodologyVersion: groups.methodologyVersion,
    };
  });
}
