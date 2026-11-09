import { decisionRecapSchema } from "../../domain/src/decision-recap";
import { redactLearningSecrets } from "../../agent/src/experience-extractor";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import {
  buildResearchMemoryRecord,
  researchArtifactHash,
  researchMemoryHash,
  type ResearchArtifactKind,
  type ResearchArtifactSnapshot,
} from "../../domain/src/research-memory-version";
import type { MemoryRecord } from "../../integrations/src/memwal";
export type ResearchArtifactReceipt = { hash: string; blobId: string };
export interface ResearchArtifactClaim {
  id: string;
  ownerId: string;
  reviewerId: string;
  grantId: string;
  kind: ResearchArtifactKind;
  artifactId: string;
  record: MemoryRecord;
  recordHash: string;
  snapshotHash: string;
  attempt: number;
  token: string;
  receipt: ResearchArtifactReceipt | null;
}
const json = (v: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(v));
// Match the existing research queue hash format, whose key sorting uses localeCompare.
function queueCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(queueCanonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${queueCanonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const queueHash = (value: unknown) =>
  createHash("sha256").update(queueCanonical(value)).digest("hex");
/** Every payload is derived from retained owner-bound database evidence, never caller-supplied prose. */
export async function deriveResearchArtifact(
  pool: Pool | PoolClient,
  ownerId: string,
  kind: ResearchArtifactKind,
  artifactId: string,
): Promise<ResearchArtifactSnapshot> {
  let row: Record<string, unknown> | undefined,
    logicalId = `research:${kind}:${artifactId}`,
    version = 1;
  if (kind === "source_change") {
    row = (
      await pool.query(
        `SELECT e.*,w.url,w.origin_id,w.dependency_id,w.hypothesis_version FROM source_change_events e JOIN source_watches w ON w.id=e.watch_id AND w.user_id=e.user_id WHERE e.id=$1 AND e.user_id=$2 AND w.state='active' AND w.expires_at>clock_timestamp()`,
        [artifactId, ownerId],
      )
    ).rows[0];
    if (
      row &&
      (row.before_hash === row.after_hash ||
        row.before_value === row.after_value)
    )
      throw Error("NON_MEANINGFUL_SOURCE_CHANGE");
  } else if (kind === "accountability_review") {
    const review = (
      await pool.query(
        `SELECT e.* FROM explanation_reviews e JOIN action_memory_preferences a ON a.user_id=e.user_id AND a.memory_consent=true WHERE e.id=$1 AND e.user_id=$2 AND e.revision=(SELECT max(x.revision) FROM explanation_reviews x WHERE x.user_id=e.user_id AND x.pick_id=e.pick_id)`,
        [artifactId, ownerId],
      )
    ).rows[0];
    if (review) {
      const recap = (
        await pool.query(
          "SELECT id,revision,payload,mode,content_hash FROM decision_recap_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
          [ownerId, review.pick_id],
        )
      ).rows[0];
      if (!recap || recap.id !== review.recap_id)
        throw Error("CURRENT_EXPLANATION_RECAP_REQUIRED");
      const cases = (
        await pool.query(
          `SELECT c.id,c.revision,c.payload FROM review_cases c WHERE c.user_id=$1 AND EXISTS(SELECT 1 FROM review_case_picks p WHERE p.user_id=c.user_id AND p.case_id=c.id AND p.pick_id=$2) ORDER BY c.id LIMIT 21`,
          [ownerId, review.pick_id],
        )
      ).rows;
      const links = (
        await pool.query(
          `SELECT p.case_id,p.pick_id,p.pick_version,p.reason_id,p.reason_version,p.disposition FROM review_case_picks p WHERE p.user_id=$1 AND p.pick_id=$2 ORDER BY p.case_id,p.reason_id LIMIT 101`,
          [ownerId, review.pick_id],
        )
      ).rows;
      const challenges = (
        await pool.query(
          `SELECT cc.id,cc.message_id,cc.answer_revision,cc.claim_id,cc.status,cc.current_revision,r.payload FROM claim_challenges cc JOIN claim_challenge_revisions r ON r.user_id=cc.user_id AND r.challenge_id=cc.id AND r.revision=cc.current_revision WHERE cc.user_id=$1 AND cc.id=ANY($2::text[]) ORDER BY cc.id LIMIT 101`,
          [ownerId, review.payload.challengeIds],
        )
      ).rows;
      const followups = (
        await pool.query(
          `SELECT id,case_id,case_revision,pick_id,reason_id,reason_version,state,due_at,timezone,updated_at FROM review_followups WHERE user_id=$1 AND pick_id=$2 ORDER BY id LIMIT 101`,
          [ownerId, review.pick_id],
        )
      ).rows;
      if (
        cases.length > 20 ||
        links.length > 100 ||
        challenges.length > 100 ||
        followups.length > 100
      )
        throw Error("ACCOUNTABILITY_ARTIFACT_LIMIT");
      const claimRuns = challenges.map((c) => c.message_id);
      const checks = (
        await pool.query(
          "SELECT id,result->'procedureChecks' AS receipts FROM agent_runs WHERE user_id=$1 AND id=ANY($2::text[]) ORDER BY id LIMIT 100",
          [ownerId, claimRuns],
        )
      ).rows;
      row = {
        id: review.id,
        user_id: ownerId,
        pick_id: review.pick_id,
        revision: review.revision,
        mode: recap.mode,
        predecessor_id: review.supersedes_id,
        explanation: review.payload,
        recap: {
          id: recap.id,
          revision: recap.revision,
          hash: recap.content_hash,
          officialResult: recap.payload.officialResult,
        },
        cases: cases.map((c) => ({
          id: c.id,
          revision: c.revision,
          hash: researchArtifactHash(c.payload),
          dissent: c.payload.dissent ?? [],
          strongestObjectionId: c.payload.strongestObjectionId ?? null,
          missingChecks: c.payload.missingChecks ?? [],
        })),
        links,
        challenges: challenges.map((c) => ({
          ...c,
          payload: {
            revision: c.payload.revision,
            verificationHash: researchArtifactHash(c.payload.verification),
          },
        })),
        followups,
        checks,
      };
      if (
        Buffer.byteLength(JSON.stringify(row), "utf8") > 64000 ||
        redactLearningSecrets(JSON.stringify(row)) !== JSON.stringify(row)
      )
        throw Error("VERIFIED_BOUNDED_ACCOUNTABILITY_REQUIRED");
      // Mutable linked state changes the content address, never overwrites an existing remote logical version.
      logicalId = `research:accountability_review:${review.pick_id}:${researchArtifactHash(row)}`;
      version = review.revision;
    }
  } else if (kind === "decision_recap") {
    row = (
      await pool.query(
        `SELECT d.id,d.user_id,d.pick_id,d.revision,d.payload,d.content_hash,d.predecessor_id,d.mode,d.created_at FROM decision_recap_versions d JOIN action_memory_preferences a ON a.user_id=d.user_id AND a.memory_consent=true WHERE d.id=$1 AND d.user_id=$2 AND d.revision=(SELECT max(x.revision) FROM decision_recap_versions x WHERE x.user_id=d.user_id AND x.pick_id=d.pick_id)`,
        [artifactId, ownerId],
      )
    ).rows[0];
    if (row) {
      const recap = decisionRecapSchema.parse(row.payload);
      if (
        recap.ownerId !== ownerId ||
        recap.officialResult.status !== "final" ||
        Buffer.byteLength(JSON.stringify(row), "utf8") > 64000 ||
        redactLearningSecrets(JSON.stringify(row)) !== JSON.stringify(row)
      )
        throw Error("VERIFIED_BOUNDED_RECAP_REQUIRED");
      const reason = recap.initialReason.reasonId
        ? (
            await pool.query(
              "SELECT id,revision,payload FROM pick_reason_versions WHERE id=$1 AND user_id=$2",
              [recap.initialReason.reasonId, ownerId],
            )
          ).rows[0]
        : null;
      const impacts = (
        await pool.query(
          "SELECT id,payload FROM pick_impact_assessments WHERE user_id=$1 AND id=ANY($2) ORDER BY id",
          [ownerId, recap.changes.map((c) => c.id)],
        )
      ).rows;
      const actions = (
        await pool.query(
          "SELECT id,payload FROM pick_review_actions WHERE user_id=$1 AND id=ANY($2) ORDER BY id",
          [ownerId, recap.choices.map((c) => c.id)],
        )
      ).rows;
      const sources = (
        await pool.query(
          "SELECT DISTINCT e.id,e.before_hash,e.after_hash,e.published_at,e.observed_at FROM source_change_events e JOIN pick_impact_assessments i ON i.change_id=e.id AND i.user_id=e.user_id WHERE i.user_id=$1 AND i.id=ANY($2) ORDER BY e.id",
          [ownerId, recap.changes.map((c) => c.id)],
        )
      ).rows;
      row = {
        ...row,
        linkedRefs: {
          reason: reason
            ? {
                id: reason.id,
                revision: reason.revision,
                hash: researchArtifactHash(reason.payload),
              }
            : null,
          impacts: impacts.map((i) => ({
            id: i.id,
            hash: researchArtifactHash(i.payload),
          })),
          actions: actions.map((a) => ({
            id: a.id,
            hash: researchArtifactHash(a.payload),
          })),
          sources,
          recap: {
            id: recap.id,
            revision: recap.revision,
            hash: researchArtifactHash(recap),
          },
        },
      };
      if (Buffer.byteLength(JSON.stringify(row), "utf8") > 64000)
        throw Error("VERIFIED_BOUNDED_RECAP_REQUIRED");
      logicalId = `research:decision_recap:${recap.pickId}`;
      version = recap.revision;
    }
  } else if (kind === "forecast_rationale") {
    row = (
      await pool.query(
        "SELECT * FROM nba_forecasts WHERE id=$1 AND user_id=$2 AND memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=$2 AND s.memory_consent=false)",
        [artifactId, ownerId],
      )
    ).rows[0];
  } else if (kind === "forecast_result") {
    row = (
      await pool.query(
        "SELECT * FROM nba_forecast_results WHERE id=$1 AND user_id=$2",
        [artifactId, ownerId],
      )
    ).rows[0];
    if (row) {
      const p = row.payload as Record<string, unknown>;
      if (p.verifiedOfficial !== true || typeof p.sourceUrl !== "string")
        throw Error("OFFICIAL_RESULT_REQUIRED");
      const u = new URL(p.sourceUrl);
      if (
        u.protocol !== "https:" ||
        !(u.hostname === "nba.com" || u.hostname.endsWith(".nba.com"))
      )
        throw Error("OFFICIAL_RESULT_REQUIRED");
      const forecasts = (
        await pool.query(
          "SELECT id,payload,request_hash,captured_at FROM nba_forecasts WHERE user_id=$1 AND namespace=$2 AND event_id=$3 AND memory_consent=true AND NOT EXISTS(SELECT 1 FROM nba_forecast_subscriptions s WHERE s.user_id=$1 AND s.memory_consent=false) ORDER BY id",
          [ownerId, row.namespace, row.event_id],
        )
      ).rows;
      if (!forecasts.length) throw Error("ORIGINAL_FORECAST_REQUIRED");
      const prior =
        (
          await pool.query(
            "SELECT id,revision,payload,recorded_at FROM nba_forecast_results WHERE user_id=$1 AND namespace=$2 AND event_id=$3 AND revision<$4 ORDER BY revision DESC LIMIT 1",
            [ownerId, row.namespace, row.event_id, row.revision],
          )
        ).rows[0] ?? null;
      row = { ...row, originalForecasts: forecasts, previousResult: prior };
      logicalId = `research:forecast_result:${row.namespace}:${row.event_id}`;
      version = Number(row.revision);
    }
  } else if (kind === "drift_summary") {
    row = (
      await pool.query(
        "SELECT id,user_id,namespace,kind,payload,payload_hash,result,result_hash,recorded_at FROM research_jobs WHERE id=$1 AND user_id=$2 AND kind='online_learning' AND state='completed'",
        [artifactId, ownerId],
      )
    ).rows[0];
    if (
      row &&
      (!row.result ||
        queueHash(row.result) !== row.result_hash ||
        queueHash(row.payload) !== row.payload_hash)
    )
      throw Error("DRIFT_RESULT_HASH_MISMATCH");
    if (row) {
      const result = row.result as Record<string, unknown>;
      if (
        result.method !== "river.predict_then_learn.ADWIN" ||
        typeof result.samples !== "number" ||
        result.samples < 1 ||
        !Array.isArray(result.streams) ||
        result.streams.length === 0 ||
        result.automaticAuthority !== false
      )
        throw Error("MEANINGFUL_DRIFT_SUMMARY_REQUIRED");
    }
  } else throw Error("UNSUPPORTED_RESEARCH_ARTIFACT");
  if (!row) throw Error("RESEARCH_ARTIFACT_NOT_AVAILABLE");
  return { kind, artifactId, logicalId, version, snapshot: json(row) };
}
function claimRow(r: Record<string, unknown>): ResearchArtifactClaim {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    reviewerId: r.reviewer_id as string,
    grantId: r.grant_id as string,
    kind: r.kind as ResearchArtifactKind,
    artifactId: r.artifact_id as string,
    record: r.record as MemoryRecord,
    recordHash: r.record_hash as string,
    snapshotHash: r.snapshot_hash as string,
    attempt: r.attempts as number,
    token: r.lease_token as string,
    receipt: r.receipt as ResearchArtifactReceipt | null,
  };
}
export async function assertResearchArtifactAuthority(
  pool: Pool,
  c: ResearchArtifactClaim,
): Promise<void> {
  const r = await pool.query(
    `SELECT g.id FROM research_artifact_memory_grants g WHERE g.id=$1 AND g.owner_id=$2 AND g.kind=$3 AND g.artifact_id=$4 AND g.snapshot_hash=$5 AND g.namespace_kind='evaluation' AND g.revoked_at IS NULL AND g.consented_at<=clock_timestamp() AND ((g.authority_kind='owner' AND g.owner_id=$6) OR (g.authority_kind='reviewed' AND EXISTS(SELECT 1 FROM procedure_reviewer_authorizations a WHERE a.user_id=$6 AND a.revoked_at IS NULL)))`,
    [c.grantId, c.ownerId, c.kind, c.artifactId, c.snapshotHash, c.reviewerId],
  );
  if (!r.rowCount) throw Error("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
  const actual = await deriveResearchArtifact(
    pool,
    c.ownerId,
    c.kind,
    c.artifactId,
  );
  if (
    researchArtifactHash(actual.snapshot) !== c.snapshotHash ||
    researchMemoryHash(c.ownerId, c.record) !== c.recordHash ||
    !isDeepStrictEqual(
      buildResearchMemoryRecord(c.ownerId, actual, c.record.recordedAt),
      c.record,
    )
  )
    throw Error("RESEARCH_ARTIFACT_SNAPSHOT_CHANGED");
}
export async function enqueueResearchArtifactMemory(
  pool: Pool,
  input: {
    ownerId: string;
    reviewerId: string;
    grantId: string;
    kind: ResearchArtifactKind;
    artifactId: string;
  },
): Promise<string> {
  const existing = await pool.query(
    "SELECT * FROM research_artifact_memory_publications WHERE owner_id=$1 AND kind=$2 AND artifact_id=$3 AND grant_id=$4",
    [input.ownerId, input.kind, input.artifactId, input.grantId],
  );
  if (existing.rowCount) {
    const c = claimRow(existing.rows[0]);
    if (c.reviewerId !== input.reviewerId)
      throw Error("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
    await assertResearchArtifactAuthority(pool, c);
    return c.id;
  }
  const artifact = await deriveResearchArtifact(
    pool,
    input.ownerId,
    input.kind,
    input.artifactId,
  );
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const record = buildResearchMemoryRecord(
    input.ownerId,
    artifact,
    now.toISOString(),
  );
  const c: ResearchArtifactClaim = {
    ...input,
    id: randomUUID(),
    record,
    recordHash: researchMemoryHash(input.ownerId, record),
    snapshotHash: researchArtifactHash(artifact.snapshot),
    attempt: 0,
    token: "",
    receipt: null,
  };
  await assertResearchArtifactAuthority(pool, c);
  const r = await pool.query(
    `INSERT INTO research_artifact_memory_publications(id,owner_id,reviewer_id,grant_id,kind,artifact_id,record,record_hash,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,kind,artifact_id,grant_id) DO UPDATE SET state=research_artifact_memory_publications.state RETURNING *`,
    [
      c.id,
      c.ownerId,
      c.reviewerId,
      c.grantId,
      c.kind,
      c.artifactId,
      c.record,
      c.recordHash,
      c.snapshotHash,
    ],
  );
  const saved = claimRow(r.rows[0]);
  if (saved.reviewerId !== input.reviewerId)
    throw Error("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
  await assertResearchArtifactAuthority(pool, saved);
  return saved.id;
}
export async function loadResearchArtifactMemory(
  pool: Pool,
  input: { id: string; ownerId: string; reviewerId: string },
): Promise<ResearchArtifactClaim> {
  const r = await pool.query(
    "SELECT * FROM research_artifact_memory_publications WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3",
    [input.id, input.ownerId, input.reviewerId],
  );
  if (!r.rowCount) throw Error("RESEARCH_ARTIFACT_MEMORY_NOT_FOUND");
  const c = claimRow(r.rows[0]);
  await assertResearchArtifactAuthority(pool, c);
  return c;
}
export async function claimResearchArtifactMemory(
  pool: Pool,
  input: { id: string; ownerId: string; reviewerId: string },
): Promise<ResearchArtifactClaim | null> {
  await pool.query(
    "UPDATE research_artifact_memory_publications SET state='blocked',lease_token=NULL,lease_until=NULL,error_code='ATTEMPTS_EXHAUSTED' WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3 AND state='processing' AND lease_until<clock_timestamp() AND attempts>=3",
    [input.id, input.ownerId, input.reviewerId],
  );
  const r = await pool.query(
    `UPDATE research_artifact_memory_publications SET state='processing',attempts=attempts+1,lease_token=$4,lease_until=clock_timestamp()+interval '120 seconds',retry_at=NULL WHERE id=$1 AND owner_id=$2 AND reviewer_id=$3 AND attempts<3 AND ((state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=clock_timestamp())) OR (state='processing' AND lease_until<clock_timestamp())) RETURNING *`,
    [input.id, input.ownerId, input.reviewerId, randomUUID()],
  );
  if (!r.rowCount) return null;
  const c = claimRow(r.rows[0]);
  try {
    await assertResearchArtifactAuthority(pool, c);
  } catch {
    await pool.query(
      "UPDATE research_artifact_memory_publications SET state='blocked',lease_until=NULL,error_code='AUTHORITY_DENIED' WHERE id=$1 AND lease_token=$2",
      [c.id, c.token],
    );
    throw Error("RESEARCH_ARTIFACT_AUTHORITY_DENIED");
  }
  return c;
}
export async function finishResearchArtifactMemory(
  pool: Pool,
  c: ResearchArtifactClaim,
  result: { status: string; hash?: string; blobId?: string },
): Promise<boolean> {
  let allowed = true;
  try {
    await assertResearchArtifactAuthority(pool, c);
  } catch {
    allowed = false;
  }
  const verified =
    allowed &&
    result.status === "verified" &&
    result.hash === c.recordHash &&
    !!result.blobId;
  const r = await pool.query(
    `UPDATE research_artifact_memory_publications p SET state=$4,lease_until=NULL,receipt=CASE WHEN $4='verified' THEN $5::jsonb ELSE receipt END,error_code=CASE WHEN $4='verified' THEN NULL ELSE 'UNVERIFIED_OR_REVOKED' END,retry_at=CASE WHEN $4='retry' THEN clock_timestamp()+interval '1 minute' ELSE NULL END WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() AND record_hash=$6 AND ($4<>'verified' OR EXISTS(SELECT 1 FROM research_artifact_memory_grants g WHERE g.id=p.grant_id AND g.owner_id=p.owner_id AND g.kind=p.kind AND g.artifact_id=p.artifact_id AND g.snapshot_hash=p.snapshot_hash AND g.namespace_kind='evaluation' AND g.consented_at<=clock_timestamp() AND g.revoked_at IS NULL AND ((g.authority_kind='owner' AND g.owner_id=p.reviewer_id) OR (g.authority_kind='reviewed' AND EXISTS(SELECT 1 FROM procedure_reviewer_authorizations a WHERE a.user_id=p.reviewer_id AND a.revoked_at IS NULL))))) RETURNING id`,
    [
      c.id,
      c.ownerId,
      c.token,
      verified ? "verified" : allowed && c.attempt < 3 ? "retry" : "blocked",
      verified ? { hash: result.hash, blobId: result.blobId } : null,
      c.recordHash,
    ],
  );
  return !!r.rowCount && verified;
}
export async function markResearchArtifactFreshRead(
  pool: Pool,
  c: ResearchArtifactClaim,
): Promise<boolean> {
  await assertResearchArtifactAuthority(pool, c);
  const r = await pool.query(
    `UPDATE research_artifact_memory_publications p SET fresh_verified_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND state='verified' AND receipt=$3::jsonb AND EXISTS(SELECT 1 FROM research_artifact_memory_grants g WHERE g.id=p.grant_id AND g.owner_id=p.owner_id AND g.snapshot_hash=p.snapshot_hash AND g.revoked_at IS NULL AND g.consented_at<=clock_timestamp() AND ((g.authority_kind='owner' AND g.owner_id=p.reviewer_id) OR (g.authority_kind='reviewed' AND EXISTS(SELECT 1 FROM procedure_reviewer_authorizations a WHERE a.user_id=p.reviewer_id AND a.revoked_at IS NULL)))) RETURNING id`,
    [c.id, c.ownerId, c.receipt],
  );
  return !!r.rowCount;
}

/** At most ten current consent grants examined and one local publication prepared. No SDK or remote write. */
export async function prepareNextResearchArtifactMemory(
  pool: Pool,
): Promise<{ prepared: number; publicationId?: string }> {
  const grants = await pool.query(
    `SELECT g.*,CASE WHEN g.authority_kind='owner' THEN g.owner_id ELSE a.user_id END AS reviewer_id FROM research_artifact_memory_grants g LEFT JOIN LATERAL(SELECT user_id FROM procedure_reviewer_authorizations WHERE revoked_at IS NULL ORDER BY user_id LIMIT 1) a ON true WHERE (g.authority_kind='owner' OR a.user_id IS NOT NULL) AND g.namespace_kind='evaluation' AND g.revoked_at IS NULL AND g.consented_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM research_artifact_memory_publications p WHERE p.owner_id=g.owner_id AND p.kind=g.kind AND p.artifact_id=g.artifact_id AND p.grant_id=g.id) ORDER BY g.consented_at,g.id LIMIT 10`,
  );
  for (const g of grants.rows) {
    try {
      const id = await enqueueResearchArtifactMemory(pool, {
        ownerId: g.owner_id,
        reviewerId: g.reviewer_id,
        grantId: g.id,
        kind: g.kind,
        artifactId: g.artifact_id,
      });
      return { prepared: 1, publicationId: id };
    } catch {
      /* Invalidated evidence never grants remote authority. Continue bounded candidate scan. */
    }
  }
  return { prepared: 0 };
}

export async function nextResearchArtifactMemoryIdentity(
  pool: Pool,
): Promise<{ id: string; ownerId: string; reviewerId: string } | null> {
  await pool.query(
    "UPDATE research_artifact_memory_publications SET state='blocked',lease_token=NULL,lease_until=NULL,error_code='ATTEMPTS_EXHAUSTED' WHERE id=(SELECT id FROM research_artifact_memory_publications WHERE state='processing' AND attempts>=3 AND lease_until<clock_timestamp() ORDER BY created_at,id LIMIT 1)",
  );
  const r = await pool.query(
    `SELECT id,owner_id,reviewer_id FROM research_artifact_memory_publications WHERE attempts<3 AND ((state IN ('pending','retry') AND (retry_at IS NULL OR retry_at<=clock_timestamp())) OR (state='processing' AND lease_until<clock_timestamp())) ORDER BY created_at,id LIMIT 1`,
  );
  return r.rowCount
    ? {
        id: r.rows[0].id,
        ownerId: r.rows[0].owner_id,
        reviewerId: r.rows[0].reviewer_id,
      }
    : null;
}
