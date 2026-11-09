import { closeReviewCasePick } from "./review-cases";
import { createHash, randomUUID } from "node:crypto";
import { recordDecisionOutcome } from "./decision-outcomes";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  recordDecisionDependencies,
  queueDependentReviews,
} from "./decision-dependencies";
import {
  assertEventNotStarted,
  assertStoredPickNotStarted,
} from "./forecast-lock";
import {
  DomainConflict,
  validateProposalAcceptance,
} from "../../domain/src/index";
export type Snapshot = {
  platform: string;
  nativeId: string;
  eventId: string | null;
  question: string;
  outcomes: { name: string; price: number | null }[];
  rulesReference: string;
  rulesHash: string;
  closeTime: string | null;
  fetchedAt: string;
  priceAsOf: string | null;
  nativeUnit: string;
  raw: unknown;
};
export type CreatePick = {
  provider?: "auto" | "public" | "tatum";
  platform: string;
  nativeId: string;
  outcome: string;
  reason: string;
  requestId: string;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function replay(
  client: PoolClient,
  userId: string,
  requestId: string,
  requestHash: string,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([userId, requestId]),
  ]);
  const old = await client.query<{ request_hash: string; result: unknown }>(
    "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
    [userId, requestId],
  );
  if (old.rows[0] && old.rows[0].request_hash !== requestHash)
    throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
  return old.rows[0];
}
async function record(
  client: PoolClient,
  userId: string,
  requestId: string,
  requestHash: string,
  result: unknown,
  kind: string,
  operationKey: string,
) {
  await client.query(
    "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
    [userId, requestId, requestHash, JSON.stringify(result)],
  );
  await client.query(
    "INSERT INTO outbox(operation_key,user_id,kind,payload) VALUES($1,$2,$3,$4)",
    [operationKey, userId, kind, JSON.stringify(result)],
  );
}
export function createPick(
  pool: Pool,
  userId: string,
  input: CreatePick,
  resolve: () => Promise<Snapshot>,
) {
  return transaction(pool, async (client) => {
    const requestHash = hash({ kind: "pick.create", ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    const s = await resolve();
    const checkedAt = (
      await client.query("SELECT clock_timestamp() AS checked_at")
    ).rows[0].checked_at;
    assertEventNotStarted(s.raw, new Date(checkedAt));
    if (
      s.platform !== input.platform ||
      s.nativeId !== input.nativeId ||
      !s.outcomes.some((o) => o.name === input.outcome)
    )
      throw new Error("OUTCOME_NOT_IN_MARKET");
    const pickId = randomUUID(),
      snapshotId = randomUUID();
    await client.query(
      "INSERT INTO markets(platform,native_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [s.platform, s.nativeId],
    );
    await client.query(
      "INSERT INTO market_snapshots(id,platform,native_id,event_id,question,outcomes,rules_reference,rules_hash,close_time,fetched_at,price_as_of,native_unit,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        snapshotId,
        s.platform,
        s.nativeId,
        s.eventId,
        s.question,
        JSON.stringify(s.outcomes),
        s.rulesReference,
        s.rulesHash,
        s.closeTime,
        s.fetchedAt,
        s.priceAsOf,
        s.nativeUnit,
        JSON.stringify(s.raw),
      ],
    );
    await client.query(
      "INSERT INTO picks(id,user_id,platform,native_id) VALUES($1,$2,$3,$4)",
      [pickId, userId, s.platform, s.nativeId],
    );
    await client.query(
      "INSERT INTO pick_versions(pick_id,user_id,version,snapshot_id,outcome,reason,assumptions,created_at) VALUES($1,$2,1,$3,$4,$5,'[]',clock_timestamp())",
      [pickId, userId, snapshotId, input.outcome, input.reason],
    );
    const result = { pickId, version: 1 };
    await record(
      client,
      userId,
      input.requestId,
      requestHash,
      result,
      "pick.version.created",
      JSON.stringify(["pick", pickId, 1]),
    );
    return result;
  });
}
export async function readPicks(pool: Pool, userId: string, pickId?: string) {
  const result = await pool.query(
    `SELECT p.id,p.platform,p.native_id,p.current_version,p.state,p.created_at,v.outcome,v.reason,v.assumptions,v.snapshot_id,s.question,s.raw->>'eventTitle' AS event_title,s.raw->>'catalogProvider' AS catalog_provider,s.outcomes,s.rules_reference,s.rules_hash,s.fetched_at,s.price_as_of FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.user_id=$1 ${pickId ? "AND p.id=$2" : ""} ORDER BY p.created_at DESC,p.id DESC LIMIT 100`,
    pickId ? [userId, pickId] : [userId],
  );
  if (pickId && !result.rows[0]) throw new Error("NOT_FOUND");
  const reviewRows = (
    await pool.query(
      `SELECT p.pick_id,r.dependency_status,r.explanation,r.recorded_at FROM decision_advice_reviews r JOIN change_proposals p ON p.id=r.decision_id AND p.user_id=r.user_id WHERE r.user_id=$1 AND p.pick_id=ANY($2::text[]) AND r.state='review_required' ORDER BY r.recorded_at DESC LIMIT 100`,
      [userId, result.rows.map((r) => r.id)],
    )
  ).rows;
  for (const row of result.rows)
    row.advice_reviews = reviewRows
      .filter((r) => r.pick_id === row.id)
      .slice(0, 5);
  return pickId ? result.rows[0] : result.rows;
}
export type ProposePick = {
  sourceRunId?: string | undefined;
  baseVersion: number;
  requestId: string;
  changes: { outcome?: string | undefined; reason?: string | undefined };
  reason: string;
};
export function proposePick(
  pool: Pool,
  userId: string,
  pickId: string,
  input: ProposePick,
  freshEvidence?: Snapshot,
) {
  return transaction(pool, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const requestHash = hash({ kind: "pick.propose", pickId, ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    const row = (
      await client.query(
        "SELECT p.current_version,p.platform,p.native_id,v.outcome,v.reason,s.outcomes,s.rules_hash FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.version=p.current_version LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.id=$1 AND p.user_id=$2 FOR UPDATE OF p",
        [pickId, userId],
      )
    ).rows[0];
    if (!row) throw new Error("NOT_FOUND");
    if (
      freshEvidence &&
      (freshEvidence.platform !== row.platform ||
        freshEvidence.nativeId !== row.native_id)
    )
      throw Error("EVIDENCE_SCOPE_MISMATCH");
    if (row.current_version !== input.baseVersion)
      throw new DomainConflict("VERSION_CONFLICT");
    await assertStoredPickNotStarted(
      client,
      userId,
      pickId,
      row.current_version,
    );
    if (
      input.changes.outcome &&
      !(row.outcomes as { name: string }[] | null)?.some(
        (o) => o.name === input.changes.outcome,
      )
    )
      throw new Error("OUTCOME_NOT_IN_MARKET");
    const proposalId = randomUUID(),
      expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await client.query(
      "INSERT INTO change_proposals(id,user_id,pick_id,base_version,changes,reason,evidence_refs,expires_at) VALUES($1,$2,$3,$4,$5,$6,'[]',$7)",
      [
        proposalId,
        userId,
        pickId,
        input.baseVersion,
        JSON.stringify(input.changes),
        input.reason,
        expiresAt,
      ],
    );
    await client.query(
      `UPDATE pick_review_proposals link SET proposal_id=$3 FROM pick_impact_assessments a WHERE link.user_id=$1 AND link.assessment_id=a.id AND a.user_id=link.user_id AND a.pick_id=$2 AND a.pick_version=$4 AND link.proposal_id IS NULL AND NOT EXISTS(SELECT 1 FROM pick_review_actions act WHERE act.user_id=link.user_id AND act.assessment_id=a.id)`,
      [userId, pickId, proposalId, input.baseVersion],
    );
    const result = {
      proposalId,
      pickId,
      baseVersion: input.baseVersion,
      before: { outcome: row.outcome, reason: row.reason },
      after: {
        outcome: input.changes.outcome ?? row.outcome,
        reason: input.changes.reason ?? row.reason,
      },
      expiresAt,
    };
    await recordDecisionDependencies(client, {
      userId,
      decisionId: proposalId,
      eventId: `${row.platform}:${row.native_id}`,
      monitoring: Boolean(
        (
          await client.query(
            "SELECT id FROM market_monitors WHERE user_id=$1 AND pick_id=$2 AND state='active' AND deadline>clock_timestamp()",
            [userId, pickId],
          )
        ).rows[0],
      ),
      consent: true,
      dependencies: [
        {
          id: `market:${row.platform}:${row.native_id}`,
          version: input.baseVersion,
          hash: hash({
            rulesHash: freshEvidence?.rulesHash ?? row.rules_hash,
            outcomes: freshEvidence?.outcomes ?? row.outcomes,
          }),
          status: "current",
        },
      ],
    });
    if (input.sourceRunId) {
      const source = (
        await client.query(
          "SELECT r.result,c.memory_consent FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.platform=$3 AND r.native_id=$4 AND r.status='completed' FOR SHARE OF c",
          [input.sourceRunId, userId, row.platform, row.native_id],
        )
      ).rows[0];
      const parsed = z
        .object({
          pick: z.object({ id: z.string(), version: z.number() }),
          reply: z.object({
            proposedChange: z.object({
              baseVersion: z.number(),
              outcome: z.string().nullable(),
              reason: z.string().nullable(),
            }),
          }),
          verifiedLearningMemories: z
            .array(
              z.object({
                id: z.string(),
                version: z.number().int().positive(),
                hash: z.string().regex(/^[a-f0-9]{64}$/),
              }),
            )
            .default([]),
        })
        .safeParse(source?.result);
      if (
        !parsed.success ||
        parsed.data.pick.id !== pickId ||
        parsed.data.pick.version !== input.baseVersion ||
        parsed.data.reply.proposedChange.baseVersion !== input.baseVersion ||
        (input.changes.outcome !== undefined &&
          parsed.data.reply.proposedChange.outcome !== input.changes.outcome) ||
        (input.changes.reason !== undefined &&
          parsed.data.reply.proposedChange.reason !== input.changes.reason)
      )
        throw new DomainConflict("SOURCE_RUN_MISMATCH");
      const memories = parsed.data.verifiedLearningMemories;
      if (memories.length && !source.memory_consent)
        throw new DomainConflict("MEMORY_REVIEW_REQUIRED");
      await recordDecisionDependencies(client, {
        userId,
        decisionId: proposalId,
        eventId: `${row.platform}:${row.native_id}`,
        monitoring: true,
        consent: source.memory_consent === true,
        dependencies: memories.map((m) => ({
          ...m,
          status: "current" as const,
        })),
      });
      await client.query(
        "UPDATE change_proposals SET evidence_refs=$3 WHERE id=$1 AND user_id=$2",
        [proposalId, userId, JSON.stringify([`run:${input.sourceRunId}`])],
      );
    }
    await client.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, input.requestId, requestHash, JSON.stringify(result)],
    );
    return result;
  });
}
export function confirmPick(
  pool: Pool,
  userId: string,
  pickId: string,
  input: { proposalId: string; requestId: string; confirmed: true },
  freshEvidence?: Snapshot,
) {
  return transaction(pool, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const requestHash = hash({ kind: "pick.confirm", pickId, ...input });
    const old = await replay(client, userId, input.requestId, requestHash);
    if (old) return old.result;
    // Lock the pick first for a consistent order across proposal creation and acceptance.
    const pick = (
      await client.query(
        "SELECT current_version FROM picks WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [pickId, userId],
      )
    ).rows[0];
    if (!pick) throw new Error("NOT_FOUND");
    const row = (
      await client.query(
        "SELECT * FROM change_proposals WHERE id=$1 AND user_id=$2 AND pick_id=$3 FOR UPDATE",
        [input.proposalId, userId, pickId],
      )
    ).rows[0];
    if (!row) throw new Error("NOT_FOUND");
    const proposal = validateProposalAcceptance(
      {
        id: row.id,
        userId: row.user_id,
        pickId: row.pick_id,
        baseVersion: row.base_version,
        changes: row.changes,
        reason: row.reason,
        evidenceRefs: row.evidence_refs,
        expiresAt: row.expires_at.toISOString(),
        status: row.status,
      },
      { userId, pickId, currentVersion: pick.current_version, now: new Date() },
    );
    const linkedReviews = (
      await client.query(
        `SELECT a.*,l.request_id FROM pick_review_proposals l JOIN pick_impact_assessments a ON a.id=l.assessment_id AND a.user_id=l.user_id WHERE l.user_id=$1 AND l.proposal_id=$2`,
        [userId, input.proposalId],
      )
    ).rows;
    for (const review of linkedReviews) {
      if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true")
        await closeReviewCasePick(client, userId, review.id, "updated");
      const latest = (
        await client.query(
          "SELECT max(revision) AS revision FROM pick_reason_versions WHERE user_id=$1 AND pick_id=$2 AND pick_version=$3",
          [userId, pickId, pick.current_version],
        )
      ).rows[0];
      if (
        review.pick_version !== pick.current_version ||
        review.reason_revision !== latest.revision
      )
        throw new DomainConflict("STALE_REVIEW");
      const active = (
        await client.query(
          "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1 FOR SHARE",
          [userId],
        )
      ).rows[0];
      if (!active?.memory_consent)
        throw new DomainConflict("MONITORING_CONSENT_REQUIRED");
    }
    const current = (
      await client.query(
        "SELECT * FROM pick_versions WHERE pick_id=$1 AND user_id=$2 AND version=$3",
        [pickId, userId, pick.current_version],
      )
    ).rows[0];
    if (!current) throw new Error("NOT_FOUND");
    const lessonDependencies = (
      await client.query(
        "SELECT d.dependency_id,d.dependency_version,l.current_version,v.status,v.approval,v.expires_at,o.payload->'memoryConsent' AS memory_consent FROM decision_dependencies d JOIN lessons l ON l.id=d.dependency_id AND l.user_id=d.user_id JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id AND v.version=l.current_version LEFT JOIN outbox o ON o.user_id=l.user_id AND o.kind='lesson.version.created' AND o.payload->>'lessonId'=l.id AND o.payload->>'version'=l.current_version::text WHERE d.user_id=$1 AND d.decision_id=$2 FOR SHARE OF l",
        [userId, proposal.id],
      )
    ).rows;
    for (const dependency of lessonDependencies)
      if (
        dependency.current_version !== dependency.dependency_version ||
        dependency.status !== "active" ||
        dependency.approval !== "approved" ||
        dependency.memory_consent !== true ||
        (dependency.expires_at && new Date(dependency.expires_at) <= new Date())
      )
        throw new DomainConflict("MEMORY_REVIEW_REQUIRED");
    for (const reference of proposal.evidenceRefs.filter((ref) =>
      ref.startsWith("run:"),
    )) {
      const consent = (
        await client.query(
          "SELECT c.memory_consent FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.id=$2 FOR SHARE OF c",
          [userId, reference.slice(4)],
        )
      ).rows[0];
      if (lessonDependencies.length && !consent?.memory_consent)
        throw new DomainConflict("MEMORY_REVIEW_REQUIRED");
    }
    const pendingReview = (
      await client.query(
        "SELECT id FROM learning_jobs WHERE user_id=$1 AND kind='advice_review' AND payload->>'decisionId'=$2 LIMIT 1",
        [userId, proposal.id],
      )
    ).rows[0];
    if (pendingReview) throw new DomainConflict("EVIDENCE_REVIEW_REQUIRED");
    if (freshEvidence) {
      const dependency = (
        await client.query(
          "SELECT dependency_hash FROM decision_dependencies WHERE user_id=$1 AND decision_id=$2 AND dependency_id=$3",
          [
            userId,
            proposal.id,
            `market:${freshEvidence.platform}:${freshEvidence.nativeId}`,
          ],
        )
      ).rows[0];
      const saved = (
        await client.query(
          "SELECT p.platform,p.native_id,s.rules_hash,s.outcomes FROM picks p JOIN market_snapshots s ON s.id=$3 WHERE p.user_id=$1 AND p.id=$2",
          [userId, pickId, current.snapshot_id],
        )
      ).rows[0];
      const checkedAt = (
        await client.query("SELECT clock_timestamp() AS checked_at")
      ).rows[0].checked_at;
      const age =
        new Date(checkedAt).getTime() - Date.parse(freshEvidence.fetchedAt);
      if (
        !saved ||
        saved.platform !== freshEvidence.platform ||
        saved.native_id !== freshEvidence.nativeId ||
        !Number.isFinite(age) ||
        age < -5000 ||
        age > 120000 ||
        (dependency?.dependency_hash ??
          hash({ rulesHash: saved.rules_hash, outcomes: saved.outcomes })) !==
          hash({
            rulesHash: freshEvidence.rulesHash,
            outcomes: freshEvidence.outcomes,
          })
      )
        throw new DomainConflict("EVIDENCE_REVIEW_REQUIRED");
      assertEventNotStarted(freshEvidence.raw, new Date(checkedAt));
    }
    await assertStoredPickNotStarted(
      client,
      userId,
      pickId,
      pick.current_version,
    );
    const version = pick.current_version + 1;
    await client.query(
      "INSERT INTO pick_versions(pick_id,user_id,version,parent_version,snapshot_id,outcome,reason,assumptions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",
      [
        pickId,
        userId,
        version,
        pick.current_version,
        current.snapshot_id,
        proposal.changes.outcome ?? current.outcome,
        proposal.changes.reason ?? current.reason,
        JSON.stringify(current.assumptions),
      ],
    );
    await client.query(
      "UPDATE picks SET current_version=$1 WHERE id=$2 AND user_id=$3",
      [version, pickId, userId],
    );
    await client.query(
      "UPDATE change_proposals SET status='accepted' WHERE id=$1",
      [proposal.id],
    );
    await recordDecisionOutcome(client, {
      userId,
      proposalId: proposal.id,
      pickId,
      decision: "confirmed",
      requestId: input.requestId,
    });
    await queueDependentReviews(client, userId, {
      id: pickId,
      version,
      hash: hash({
        id: pickId,
        version,
        outcome: proposal.changes.outcome ?? current.outcome,
        reason: proposal.changes.reason ?? current.reason,
      }),
      status: "current",
    });
    for (const review of linkedReviews) {
      await client.query(
        "INSERT INTO pick_review_actions(id,user_id,assessment_id,request_id,action,payload) VALUES($1,$2,$3,$4,'update',$5) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          userId,
          review.id,
          review.request_id,
          JSON.stringify({
            proposalId: input.proposalId,
            pickVersion: version,
            confirmed: true,
          }),
        ],
      );
      await client.query(
        "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'decision_recap',$3,$4) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          userId,
          `review-update:${review.id}:${input.proposalId}`,
          JSON.stringify({ pickId }),
        ],
      );
    }
    const result = { pickId, version };
    await record(
      client,
      userId,
      input.requestId,
      requestHash,
      result,
      "pick.version.created",
      JSON.stringify(["pick", pickId, version]),
    );
    return result;
  });
}
