import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  researchArtifactHash,
  type ResearchArtifactKind,
} from "../../domain/src/research-memory-version";
import { deriveResearchArtifact } from "./research-artifact-memory";

export const artifactConsentPolicy = "personal-research-artifact-walrus-v1";
export async function inspectResearchArtifact(
  pool: Pool,
  ownerId: string,
  kind: ResearchArtifactKind,
  artifactId: string,
) {
  const artifact = await deriveResearchArtifact(
    pool,
    ownerId,
    kind,
    artifactId,
  );
  const inspectionId = randomUUID(),
    snapshotHash = researchArtifactHash(artifact.snapshot);
  await pool.query(
    "INSERT INTO research_artifact_memory_inspections(id,owner_id,kind,artifact_id,snapshot_hash) VALUES($1,$2,$3,$4,$5)",
    [inspectionId, ownerId, kind, artifactId, snapshotHash],
  );
  return {
    ...artifact,
    inspectionId,
    snapshotHash,
    policy: artifactConsentPolicy,
  };
}
export async function grantResearchArtifactConsent(
  pool: Pool,
  ownerId: string,
  input: { inspectionId: string; snapshotHash: string },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (
      await client.query(
        "SELECT * FROM research_artifact_memory_inspections WHERE id=$1 AND owner_id=$2 AND snapshot_hash=$3 AND expires_at>clock_timestamp() FOR UPDATE",
        [input.inspectionId, ownerId, input.snapshotHash],
      )
    ).rows[0];
    if (!row) throw Error("INSPECTION_NOT_AVAILABLE");
    // Derivation is owner scoped and repeated after inspection. Queue authority repeats it before all remote work.
    const actual = await deriveResearchArtifact(
      client,
      ownerId,
      row.kind,
      row.artifact_id,
    );
    if (researchArtifactHash(actual.snapshot) !== input.snapshotHash)
      throw Error("RESEARCH_ARTIFACT_SNAPSHOT_CHANGED");
    if (row.grant_id) {
      const grant = (
        await client.query(
          "SELECT * FROM research_artifact_memory_grants WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL",
          [row.grant_id, ownerId],
        )
      ).rows[0];
      if (!grant) throw Error("CONSENT_REVOKED");
      await client.query("COMMIT");
      return grant;
    }
    const grant = (
      await client.query(
        `INSERT INTO research_artifact_memory_grants(id,owner_id,kind,artifact_id,snapshot_hash,namespace_kind,consent_evidence_ref,consented_at,authority_kind,consent_evidence) VALUES($1,$2,$3,$4,$5,'evaluation',$6,clock_timestamp(),'owner',jsonb_build_object('policy',$7::text,'inspectionId',$8::text,'snapshotHash',$5::text,'actorId',$2::text,'confirmed',true,'recordedAt',clock_timestamp())) RETURNING *`,
        [
          randomUUID(),
          ownerId,
          row.kind,
          row.artifact_id,
          input.snapshotHash,
          `owner-inspection:${row.id}`,
          artifactConsentPolicy,
          row.id,
        ],
      )
    ).rows[0];
    await client.query(
      "UPDATE research_artifact_memory_inspections SET grant_id=$2 WHERE id=$1",
      [row.id, grant.id],
    );
    await client.query("COMMIT");
    return grant;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function revokeResearchArtifactConsent(
  pool: Pool,
  ownerId: string,
  grantId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "UPDATE research_artifact_memory_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND owner_id=$2 RETURNING id",
      [grantId, ownerId],
    );
    if (r.rowCount)
      await client.query(
        "UPDATE research_artifact_memory_publications SET state='blocked',lease_token=NULL,lease_until=NULL,error_code='OWNER_REVOKED' WHERE grant_id=$1 AND owner_id=$2",
        [grantId, ownerId],
      );
    await client.query("COMMIT");
    return !!r.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listResearchArtifactConsent(pool: Pool, ownerId: string) {
  const candidates = (
    await pool.query(
      `SELECT 'source_change' AS kind,e.id AS artifact_id,e.observed_at AS recorded_at FROM source_change_events e JOIN source_watches w ON w.id=e.watch_id AND w.user_id=e.user_id WHERE e.user_id=$1 AND w.state='active' AND w.expires_at>clock_timestamp()
    UNION ALL SELECT 'forecast_rationale',id,captured_at FROM nba_forecasts WHERE user_id=$1 AND memory_consent=true
    UNION ALL SELECT 'forecast_result',id,recorded_at FROM nba_forecast_results WHERE user_id=$1
    UNION ALL SELECT 'accountability_review',id,created_at FROM explanation_reviews WHERE user_id=$1
    UNION ALL SELECT 'decision_recap',id,created_at FROM decision_recap_versions WHERE user_id=$1 AND payload->'officialResult'->>'status'='final'
    UNION ALL SELECT 'drift_summary',id,recorded_at FROM research_jobs WHERE user_id=$1 AND kind='online_learning' AND state='completed'
    ORDER BY recorded_at DESC LIMIT 30`,
      [ownerId],
    )
  ).rows;
  const grants = (
    await pool.query(
      `SELECT g.id,g.kind,g.artifact_id,g.snapshot_hash,g.consented_at,g.revoked_at,g.authority_kind,p.state,p.receipt FROM research_artifact_memory_grants g LEFT JOIN research_artifact_memory_publications p ON p.grant_id=g.id AND p.owner_id=g.owner_id WHERE g.owner_id=$1 ORDER BY g.consented_at DESC LIMIT 50`,
      [ownerId],
    )
  ).rows;
  const eligible = [];
  for (const candidate of candidates) {
    try {
      await deriveResearchArtifact(
        pool,
        ownerId,
        candidate.kind,
        candidate.artifact_id,
      );
      eligible.push(candidate);
    } catch {
      /* Ineligible or invalidated evidence is never offered for consent. */
    }
  }
  return { candidates: eligible, grants };
}
