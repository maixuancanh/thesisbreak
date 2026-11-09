import {
  debateSideSchema,
  debateDispositionSchema,
} from "../../domain/src/evidence-debate";
import { queueCaseFollowups } from "./review-followups";
import { createHash, randomUUID } from "node:crypto";
import {
  reviewCaseDebateEvidence,
  type runEvidenceDebate,
} from "../../agent/src/evidence-debate";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { monitoringTransaction } from "./pick-reasons";
import {
  reviewCaseSchema,
  type ReviewCase,
} from "../../domain/src/review-case";
/** Called in the impact transaction, after a verified assessment was persisted. */
export async function upsertReviewCaseFromAssessment(
  c: PoolClient,
  ownerId: string,
  assessmentId: string,
) {
  const a = (
    await c.query(
      `SELECT a.*,w.event_id,w.dependency_id,w.state AS watch_state,w.expires_at,e.watch_id FROM pick_impact_assessments a JOIN source_change_events e ON e.id=a.change_id AND e.user_id=a.user_id JOIN source_watches w ON w.id=e.watch_id AND w.user_id=a.user_id JOIN picks p ON p.id=a.pick_id AND p.user_id=a.user_id AND p.current_version=a.pick_version WHERE a.id=$1 AND a.user_id=$2 AND a.state<>'still_watching' AND NOT EXISTS(SELECT 1 FROM pick_impact_assessments newer WHERE newer.user_id=a.user_id AND newer.change_id=a.change_id AND newer.reason_id=a.reason_id AND (newer.checked_at,newer.id)>(a.checked_at,a.id)) AND w.state='active' AND w.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM pick_watch_bindings b WHERE b.user_id=a.user_id AND b.reason_id=a.reason_id AND b.watch_id=w.id AND b.state='active') AND NOT EXISTS(SELECT 1 FROM pick_reason_versions r WHERE r.user_id=a.user_id AND r.pick_id=a.pick_id AND r.pick_version=a.pick_version AND r.revision>a.reason_revision) FOR SHARE OF w,p`,
      [assessmentId, ownerId],
    )
  ).rows[0];
  if (!a) return null;
  const key = {
    ownerId,
    eventId: a.event_id,
    triggerEvidenceRevisionId: a.change_id,
    reasonDependencyId: a.dependency_id,
  };
  const id = randomUUID();
  const payload = {
    ...key,
    id,
    revision: 1,
    summary: null,
    supportingEvidenceIds: [],
    opposingEvidenceIds: [],
    missingChecks: ["Dissent has not been assessed"],
    dissent: [],
    strongestObjectionId: null,
    picks: [],
    createdAt: new Date().toISOString(),
  };
  const row = (
    await c.query(
      `INSERT INTO review_cases(id,user_id,event_id,trigger_evidence_revision_id,reason_dependency_id,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,event_id,trigger_evidence_revision_id,reason_dependency_id) DO UPDATE SET updated_at=clock_timestamp() RETURNING id`,
      [
        id,
        ownerId,
        a.event_id,
        a.change_id,
        a.dependency_id,
        JSON.stringify(payload),
      ],
    )
  ).rows[0];
  const changed = await c.query(
    `INSERT INTO review_case_picks(case_id,user_id,pick_id,pick_version,reason_id,reason_version,assessment_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(case_id,pick_id,reason_id) DO UPDATE SET assessment_id=EXCLUDED.assessment_id,updated_at=clock_timestamp() WHERE review_case_picks.assessment_id IS DISTINCT FROM EXCLUDED.assessment_id RETURNING assessment_id`,
    [
      row.id,
      ownerId,
      a.pick_id,
      a.pick_version,
      a.reason_id,
      a.reason_revision,
      assessmentId,
    ],
  );
  if (changed.rowCount)
    await c.query(
      "UPDATE review_cases SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2",
      [row.id, ownerId],
    );
  await queueCaseFollowups(c, ownerId, row.id);
  return row.id as string;
}
export async function recordReviewCaseFromAssessment(
  pool: Pool,
  ownerId: string,
  assessmentId: string,
) {
  return monitoringTransaction(pool, ownerId, (c) =>
    upsertReviewCaseFromAssessment(c, ownerId, assessmentId),
  );
}
export async function listReviewCases(
  pool: Pool,
  ownerId: string,
  options: { afterId?: string; limit?: number; caseId?: string } = {},
) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(options.limit ?? 20);
  return monitoringTransaction(pool, ownerId, async (c) => {
    const rows = (
      await c.query(
        "SELECT * FROM review_cases WHERE user_id=$1 AND ($2::text IS NULL OR id>$2) AND ($3::text IS NULL OR id=$3) ORDER BY id LIMIT $4",
        [ownerId, options.afterId ?? null, options.caseId ?? null, limit + 1],
      )
    ).rows;
    const items: ReviewCase[] = [];
    for (const row of rows.slice(0, limit)) {
      const links = (
        await c.query(
          "SELECT * FROM review_case_picks WHERE user_id=$1 AND case_id=$2 ORDER BY pick_id,reason_id",
          [ownerId, row.id],
        )
      ).rows;
      items.push(
        reviewCaseSchema.parse({
          ...row.payload,
          id: row.id,
          ownerId,
          revision: row.revision,
          picks: links.map((l) => ({
            pickId: l.pick_id,
            pickVersion: l.pick_version,
            reasonId: l.reason_id,
            reasonVersion: l.reason_version,
            disposition: l.disposition,
            assessmentId: l.assessment_id,
          })),
        }),
      );
    }
    return {
      items,
      nextCursor: rows.length > limit ? (rows[limit - 1].id as string) : null,
    };
  });
}
export async function saveReviewCaseSummary(
  pool: Pool,
  ownerId: string,
  caseId: string,
  expectedRevision: number,
  summary: Pick<
    ReviewCase,
    | "summary"
    | "supportingEvidenceIds"
    | "opposingEvidenceIds"
    | "missingChecks"
    | "dissent"
    | "strongestObjectionId"
    | "strongestObjectionExplanation"
  >,
  debateRunId?: string,
) {
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM review_cases WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [caseId, ownerId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.revision !== expectedRevision) throw Error("STALE_CASE");
    const frozen = (
      await c.query(
        "SELECT a.payload FROM review_case_picks l JOIN pick_impact_assessments a ON a.id=l.assessment_id AND a.user_id=l.user_id WHERE l.case_id=$1 AND l.user_id=$2",
        [caseId, ownerId],
      )
    ).rows;
    const allowed = new Set<string>(
      frozen.flatMap((r) => [
        ...(r.payload.beforeRefs ?? []),
        ...(r.payload.afterRefs ?? []),
      ]),
    );
    let debateProof: ReviewCase["debateProof"];
    if (debateRunId) {
      const eligible = (
        await c.query(
          `SELECT l.pick_id FROM review_case_picks l
        JOIN picks p ON p.id=l.pick_id AND p.user_id=l.user_id AND p.current_version=l.pick_version
        JOIN pick_reason_versions r ON r.id=l.reason_id AND r.user_id=l.user_id
        JOIN review_cases rc ON rc.id=l.case_id AND rc.user_id=l.user_id
        JOIN source_change_events sc ON sc.id=rc.trigger_evidence_revision_id AND sc.user_id=rc.user_id
        JOIN pick_watch_bindings b ON b.reason_id=r.id AND b.user_id=r.user_id AND b.watch_id=sc.watch_id AND b.state='active'
        JOIN source_watches w ON w.id=b.watch_id AND w.user_id=b.user_id AND w.state='active' AND w.expires_at>clock_timestamp()
        JOIN action_memory_preferences ap ON ap.user_id=l.user_id AND ap.memory_consent
        WHERE l.case_id=$1 AND l.user_id=$2 AND l.disposition='pending'
        AND NOT EXISTS(SELECT 1 FROM pick_reason_versions newer WHERE newer.user_id=r.user_id AND newer.pick_id=r.pick_id AND newer.pick_version=r.pick_version AND newer.revision>r.revision)
        FOR SHARE OF p,b,w,ap`,
          [caseId, ownerId],
        )
      ).rows;
      if (!eligible.length) throw Error("DEBATE_REVIEW_NO_LONGER_ELIGIBLE");
      const run = (
        await c.query(
          `SELECT result FROM agent_runs WHERE id=$1 AND user_id=$2 AND status='completed' FOR SHARE`,
          [debateRunId, ownerId],
        )
      ).rows[0];
      if (
        !run ||
        !run.result.evidenceDebate ||
        !Array.isArray(run.result.learningEvidence)
      )
        throw Error("DEBATE_PROOF_UNAVAILABLE");
      const linked = (
        await c.query(
          `SELECT 1 FROM review_case_picks WHERE case_id=$1 AND user_id=$2 AND pick_id=$3 AND pick_version=$4`,
          [caseId, ownerId, run.result.pick?.id, run.result.pick?.version],
        )
      ).rowCount;
      if (!linked) throw Error("DEBATE_PICK_MISMATCH");
      for (const side of Object.values(run.result.evidenceDebate.sides ?? {}))
        debateSideSchema.parse(side);
      if (run.result.evidenceDebate.result)
        debateDispositionSchema.parse(run.result.evidenceDebate.result);
      if (!eligible.some((l) => l.pick_id === run.result.pick?.id))
        throw Error("DEBATE_REVIEW_NO_LONGER_ELIGIBLE");
      const original = reviewCaseDebateEvidence(
        run.result.evidenceDebate as Awaited<
          ReturnType<typeof runEvidenceDebate>
        >,
      );
      if (
        original.strongestObjectionId !== summary.strongestObjectionId ||
        original.strongestObjectionExplanation !==
          summary.strongestObjectionExplanation
      )
        throw Error("DEBATE_OBJECTION_SELECTION_MISMATCH");
      if (JSON.stringify(original.dissent) !== JSON.stringify(summary.dissent))
        throw Error("DEBATE_DISSENT_MISMATCH");
      if (
        JSON.stringify(original.supportingEvidenceIds) !==
          JSON.stringify(summary.supportingEvidenceIds) ||
        JSON.stringify(original.opposingEvidenceIds) !==
          JSON.stringify(summary.opposingEvidenceIds)
      )
        throw Error("DEBATE_SUMMARY_MISMATCH");
      if (row.payload.debateProof?.runId === debateRunId)
        return reviewCaseSchema.parse({
          ...row.payload,
          revision: row.revision,
        });
      z.array(
        z
          .object({
            id: z.string().min(1).max(300),
            text: z.string().max(16000),
            retrievedAt: z.iso.datetime({ offset: true }),
          })
          .passthrough(),
      )
        .max(100)
        .parse(run.result.learningEvidence);
      const evidence = run.result.learningEvidence.map(
        (s: { id: string; text: string; retrievedAt: string }) => ({
          id: s.id,
          sha256: createHash("sha256").update(s.text).digest("hex"),
          retrievedAt: s.retrievedAt,
        }),
      );
      for (const s of evidence) allowed.add(s.id);
      debateProof = { runId: debateRunId, evidence };
    }
    for (const ref of [
      ...summary.supportingEvidenceIds,
      ...summary.opposingEvidenceIds,
      ...summary.dissent.flatMap((d) => d.evidenceIds),
    ])
      if (!allowed.has(ref)) throw Error("UNFROZEN_EVIDENCE");
    const payload = reviewCaseSchema.parse({
      ...row.payload,
      ...summary,
      ...(debateProof ? { debateProof } : {}),
      revision: row.revision + 1,
    });
    await c.query(
      "UPDATE review_cases SET payload=$3,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2",
      [caseId, ownerId, JSON.stringify(payload)],
    );
    await queueCaseFollowups(c, ownerId, caseId);
    return payload;
  });
}
/** Called after a completed, server-generated answer; preserves exact frozen dissent. */
export async function persistReviewCaseDebateFromRun(
  pool: Pool,
  ownerId: string,
  assessmentId: string,
  runId: string,
) {
  const input = await monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        `SELECT rc.id,rc.revision,r.result FROM review_case_picks l
      JOIN review_cases rc ON rc.id=l.case_id AND rc.user_id=l.user_id
      JOIN agent_runs r ON r.user_id=l.user_id AND r.id=$3 AND r.status='completed'
      WHERE l.user_id=$1 AND l.assessment_id=$2`,
        [ownerId, assessmentId, runId],
      )
    ).rows[0];
    return row;
  });
  if (!input?.result.evidenceDebate?.result) return null;
  const summary = reviewCaseDebateEvidence(input.result.evidenceDebate);
  return saveReviewCaseSummary(
    pool,
    ownerId,
    input.id,
    input.revision,
    { ...summary, summary: input.result.evidenceDebate.result.explanation },
    runId,
  );
}
/** Update only the individually confirmed assessment; no bulk pick decision. */
export async function closeReviewCasePick(
  c: PoolClient,
  ownerId: string,
  assessmentId: string,
  disposition: "kept" | "updated" | "stopped",
) {
  await c.query(
    "UPDATE review_case_picks SET disposition=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND assessment_id=$2",
    [ownerId, assessmentId, disposition],
  );
  await c.query(
    `UPDATE review_followups f SET state=$3,updated_at=clock_timestamp() FROM review_case_picks l WHERE l.user_id=$1 AND l.assessment_id=$2 AND f.user_id=l.user_id AND f.case_id=l.case_id AND f.pick_id=l.pick_id AND f.reason_id=l.reason_id AND f.state IN ('pending','snoozed')`,
    [
      ownerId,
      assessmentId,
      disposition === "stopped" ? "stopped" : "acknowledged",
    ],
  );
}
