import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  explanationReviewSchema,
  type ExplanationStatus,
} from "../../domain/src/explanation-review";
import { monitoringTransaction } from "./pick-reasons";

/** Explanation revisions never write official settlement or forecast records. */
export async function appendExplanationReview(
  c: Pick<PoolClient, "query">,
  ownerId: string,
  pickId: string,
  status: ExplanationStatus,
  input: {
    challengeId: string;
    challengeIds?: string[];
    dependencyRefs: { id: string; revision: number }[];
    evidenceIds: string[];
    summary: string;
  },
) {
  await c.query("SELECT id FROM picks WHERE user_id=$1 AND id=$2 FOR UPDATE", [
    ownerId,
    pickId,
  ]);
  const recap = (
    await c.query(
      "SELECT id FROM decision_recap_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
      [ownerId, pickId],
    )
  ).rows[0];
  if (!recap) return null;
  const old = (
    await c.query(
      "SELECT * FROM explanation_reviews WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
      [ownerId, pickId],
    )
  ).rows[0];
  const payload = explanationReviewSchema.parse({
    id: randomUUID(),
    ownerId,
    pickId,
    recapId: recap.id,
    revision: (old?.revision ?? 0) + 1,
    status,
    dependencyRefs: input.dependencyRefs,
    evidenceIds: input.evidenceIds,
    challengeIds: [
      ...new Set([
        ...(old?.payload.challengeIds ?? []),
        ...(input.challengeIds ?? []),
        input.challengeId,
      ]),
    ],
    summary: input.summary,
    supersedesId: old?.id ?? null,
    createdAt: new Date().toISOString(),
  });
  await c.query(
    "INSERT INTO explanation_reviews(id,user_id,pick_id,recap_id,revision,status,payload,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      payload.id,
      ownerId,
      pickId,
      recap.id,
      payload.revision,
      status,
      JSON.stringify(payload),
      payload.supersedesId,
    ],
  );
  return payload;
}
export async function readExplanationReview(
  pool: Pool,
  ownerId: string,
  pickId: string,
) {
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        "SELECT payload FROM explanation_reviews WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    return row ? explanationReviewSchema.parse(row.payload) : null;
  });
}
/** Match exact cited evidence or an explicit answer reference, never every memory in the account. */
export const disputedLessonDependencySql = `NOT EXISTS (
 SELECT 1 FROM lesson_candidates dc JOIN lesson_candidate_evidence de ON de.user_id=dc.user_id AND de.candidate_id=dc.id AND de.candidate_version=dc.version
 JOIN memory_atoms da ON da.user_id=de.user_id AND da.id=de.atom_id AND da.version=de.atom_version
 JOIN answer_claims ac ON ac.user_id=dc.user_id AND (ac.evidence_ids ? (da.payload->>'reference') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(ac.evidence_ids) ae(id) WHERE da.payload->>'reference'=ac.message_id||':result:'||ae.id) OR EXISTS(SELECT 1 FROM decision_recap_versions dr WHERE dr.user_id=ac.user_id AND da.payload->>'reference'='recap:'||dr.id||':'||dr.revision AND dr.payload->'evidenceRefs' ?| ARRAY(SELECT jsonb_array_elements_text(ac.evidence_ids))) OR da.payload->>'reference' IN (ac.message_id,'answer:'||ac.message_id||':'||ac.answer_revision||':'||ac.claim_id))
 JOIN claim_challenges cc ON cc.user_id=ac.user_id AND cc.message_id=ac.message_id AND cc.answer_revision=ac.answer_revision AND cc.claim_id=ac.claim_id
 WHERE dc.user_id=l.user_id AND dc.lesson_id=l.id AND dc.lesson_version=v.version AND de.stance='support'
 AND cc.status IN ('submitted','checking','needs_evidence','accepted')
)`;
