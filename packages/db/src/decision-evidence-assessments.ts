import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { decisionEvidenceAssessmentSchema } from "../../domain/src/decision-evidence-assessment";
import { monitoringTransaction } from "./pick-reasons";
const id = z.string().trim().min(1).max(300);
const version = z.number().int().positive();
const saveSchema = z
  .object({
    caseId: id,
    caseRevision: version,
    pickId: id,
    pickVersion: version,
    reasonId: id,
    reasonVersion: version,
    assessment: decisionEvidenceAssessmentSchema,
  })
  .strict();

/** Append only, owner/version fenced. Idempotent retries cannot replace retained evidence. */
export async function saveDecisionEvidenceAssessment(
  pool: Pool,
  ownerId: string,
  value: unknown,
) {
  const input = saveSchema.parse(value);
  id.parse(ownerId);
  return monitoringTransaction(pool, ownerId, (c) =>
    saveDecisionEvidenceAssessmentInTransaction(c, ownerId, input),
  );
}
/** Caller must already hold an owner-bound transaction. */
export async function saveDecisionEvidenceAssessmentInTransaction(
  c: PoolClient,
  ownerId: string,
  value: unknown,
) {
  const input = saveSchema.parse(value);
  id.parse(ownerId);
  const current = await c.query(
    `SELECT p.id FROM review_cases r
       JOIN review_case_picks l ON l.case_id=r.id AND l.user_id=r.user_id
       JOIN picks p ON p.id=l.pick_id AND p.user_id=l.user_id
       WHERE r.id=$1 AND r.user_id=$2 AND r.revision=$3 AND l.pick_id=$4
         AND l.pick_version=$5 AND l.reason_id=$6 AND l.reason_version=$7
         AND l.disposition<>'stopped' FOR UPDATE OF r,l,p`,
    [
      input.caseId,
      ownerId,
      input.caseRevision,
      input.pickId,
      input.pickVersion,
      input.reasonId,
      input.reasonVersion,
    ],
  );
  if (!current.rowCount) throw Error("STALE_ASSESSMENT_SCOPE");
  const versions = (
    await c.query(
      `SELECT (SELECT max(version) FROM pick_versions WHERE pick_id=$1 AND user_id=$2) AS pick_version,
       (SELECT max(revision) FROM pick_reason_versions WHERE pick_id=$1 AND user_id=$2 AND pick_version=$3) AS reason_version`,
      [input.pickId, ownerId, input.pickVersion],
    )
  ).rows[0];
  if (
    versions.pick_version !== input.pickVersion ||
    versions.reason_version !== input.reasonVersion
  )
    throw Error("STALE_ASSESSMENT_SCOPE");
  const values = [
    ownerId,
    input.caseId,
    input.caseRevision,
    input.pickId,
    input.pickVersion,
    input.reasonId,
    input.reasonVersion,
  ];
  const inserted = await c.query(
    `INSERT INTO decision_evidence_assessments(id,user_id,case_id,case_revision,pick_id,pick_version,reason_id,reason_version,payload)
       VALUES($8,$1,$2,$3,$4,$5,$6,$7,$9)
       ON CONFLICT(user_id,case_id,case_revision,pick_id,reason_id,reason_version) DO NOTHING RETURNING id,payload`,
    [...values, randomUUID(), input.assessment],
  );
  const row =
    inserted.rows[0] ??
    (
      await c.query(
        `SELECT id,payload FROM decision_evidence_assessments WHERE user_id=$1 AND case_id=$2 AND case_revision=$3
       AND pick_id=$4 AND pick_version=$5 AND reason_id=$6 AND reason_version=$7`,
        values,
      )
    ).rows[0];
  if (
    !row ||
    !isDeepStrictEqual(
      decisionEvidenceAssessmentSchema.parse(row.payload),
      input.assessment,
    )
  )
    throw Error("ASSESSMENT_REVISION_CONFLICT");
  return {
    id: row.id as string,
    assessment: decisionEvidenceAssessmentSchema.parse(row.payload),
  };
}

/** Historical revisions remain readable explicitly; callers choose the current case revision. */
export async function readDecisionEvidenceAssessments(
  pool: Pool,
  ownerId: string,
  caseId: string,
  caseRevision: number,
) {
  id.parse(ownerId);
  id.parse(caseId);
  version.parse(caseRevision);
  return monitoringTransaction(pool, ownerId, async (c) => {
    const rows = (
      await c.query(
        `SELECT DISTINCT ON (pick_id,reason_id) id,pick_id,pick_version,reason_id,reason_version,payload FROM decision_evidence_assessments
       WHERE user_id=$1 AND case_id=$2 AND case_revision<=$3 ORDER BY pick_id,reason_id,case_revision DESC LIMIT 100`,
        [ownerId, caseId, caseRevision],
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id as string,
      pickId: r.pick_id as string,
      pickVersion: r.pick_version as number,
      reasonId: r.reason_id as string,
      reasonVersion: r.reason_version as number,
      assessment: decisionEvidenceAssessmentSchema.parse(r.payload),
    }));
  });
}
