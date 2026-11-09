import { claimLearningJob } from "../../db/src/learning-jobs";
import { randomUUID } from "node:crypto";
import { learningSnapshotHash } from "../../agent/src/learning-provenance";
import type { Pool } from "pg";
import { z } from "zod";
import { recordDecisionReceipt } from "../../db/src/decision-receipt";
const hash = learningSnapshotHash;
/** Receipt preparation is replayable from the same immutable completed run, with no model call. */
export async function runOneReceiptPreparation(pool: Pool, ownerId?: string) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["receipt_prepare"],
    token,
    leaseSeconds: 60,
    ownerId,
  });
  if (!job) return { checked: 0, completed: 0 };
  try {
    const run = (
      await pool.query(
        `SELECT r.*,c.memory_consent FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.status='completed'`,
        [job.payload.runId, job.user_id],
      )
    ).rows[0];
    if (!run) throw Error("OWNED_COMPLETED_RUN_REQUIRED");
    const r = z
      .object({
        learningEventId: z.string(),
        modelVersion: z.string(),
        promptVersion: z.string(),
        verifiedLearningMemories: z
          .array(
            z.object({
              id: z.string(),
              version: z.number().int().positive(),
              hash: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(50),
        learningEvidence: z
          .array(
            z.object({ id: z.string(), retrievedAt: z.string() }).passthrough(),
          )
          .max(20),
        appliedConditions: z
          .array(
            z
              .object({
                id: z.string(),
                version: z.number(),
                condition: z.string(),
              })
              .passthrough(),
          )
          .max(30),
        policyRequiredTools: z.array(z.string()),
        plannedTools: z.array(z.string()),
        trace: z.array(
          z
            .object({
              tool: z.string(),
              status: z.enum(["completed", "failed", "unavailable"]),
              count: z.number(),
              startedAt: z.iso.datetime().nullable().optional(),
              completedAt: z.iso.datetime().nullable().optional(),
              observedAt: z.iso.datetime().nullable().optional(),
              observationKind: z
                .enum(["provider_timestamp", "retrieval_timestamp"])
                .nullable()
                .optional(),
              resultHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .nullable()
                .optional(),
            })
            .passthrough(),
        ),
        researchAudit: z.object({ proposalWithheld: z.boolean() }),
      })
      .passthrough()
      .parse(run.result);
    const existing = (
      await pool.query(
        "SELECT id FROM decision_receipts WHERE user_id=$1 AND id=$2",
        [job.user_id, run.id],
      )
    ).rows[0];
    if (!existing)
      await recordDecisionReceipt(
        pool,
        job.user_id,
        {
          id: run.id,
          ownerId: job.user_id,
          eventId: r.learningEventId,
          modelVersion: r.modelVersion,
          promptVersion: r.promptVersion,
          memories: r.verifiedLearningMemories,
          appliedConditions: r.appliedConditions.map(
            (c) => `${c.id}@${c.version}:${c.condition}`,
          ),
          requiredTools: r.policyRequiredTools,
          selectedTools: r.plannedTools,
          executedTools: r.trace.map((t) => ({
            name: t.tool,
            status: t.status === "completed" ? "succeeded" : t.status,
            observedAt: t.observedAt ?? null,
            resultHash: t.resultHash ?? null,
            startedAt: t.startedAt ?? null,
            completedAt: t.completedAt ?? null,
            observationKind: t.observationKind ?? null,
          })),
          evidence: r.learningEvidence.map((e) => ({
            id: e.id,
            version: 1,
            hash: hash(e),
            observedAt: e.retrievedAt,
          })),
          ...(r.researchAudit.proposalWithheld
            ? { blockedProposal: { code: "RESEARCH_PREREQUISITE_UNMET" } }
            : {}),
          userDecision: "pending",
          publication: "pending",
          recordedAt: new Date(run.finished_at).toISOString(),
        },
        { publicationConsent: run.memory_consent === true },
      );
    const done = await pool.query(
      `UPDATE learning_jobs SET state='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token],
    );
    return { checked: 1, completed: done.rowCount === 1 ? 1 : 0 };
  } catch {
    await pool.query(
      `UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,lease_until=NULL,retry_at=clock_timestamp()+interval '5 minutes',last_error='RECEIPT_PREPARATION_FAILED' WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,
      [job.id, token],
    );
    return { checked: 1, completed: 0 };
  }
}
