import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DomainConflict } from "../../domain/src/index";
export async function recordDecisionOutcome(
  c: Pick<PoolClient, "query">,
  input: {
    userId: string;
    proposalId: string;
    pickId: string;
    runId?: string | null;
    decision: "confirmed" | "rejected";
    requestId: string;
  },
) {
  const proposal = (
    await c.query(
      "SELECT evidence_refs,status FROM change_proposals WHERE id=$1 AND user_id=$2 AND pick_id=$3",
      [input.proposalId, input.userId, input.pickId],
    )
  ).rows[0];
  if (!proposal) throw Error("NOT_FOUND");
  if (
    proposal.status !==
    (input.decision === "confirmed" ? "accepted" : "rejected")
  )
    throw new DomainConflict("DECISION_STATUS_MISMATCH");
  const rootRunId =
    input.runId ??
    proposal.evidence_refs
      ?.find((ref: string) => ref.startsWith("run:"))
      ?.slice(4) ??
    null;
  if (rootRunId) {
    const run = (
      await c.query(
        "SELECT r.id FROM agent_runs r JOIN picks p ON p.id=$3 AND p.user_id=r.user_id AND p.platform=r.platform AND p.native_id=r.native_id WHERE r.id=$1 AND r.user_id=$2 AND r.status='completed'",
        [rootRunId, input.userId, input.pickId],
      )
    ).rows[0];
    if (!run) throw new DomainConflict("SOURCE_RUN_MISMATCH");
  }
  const id = `decision:${input.proposalId}:${input.decision}`;
  const inserted = await c.query(
    "INSERT INTO decision_outcomes(user_id,id,proposal_id,pick_id,root_run_id,decision,request_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,proposal_id) DO NOTHING RETURNING id",
    [
      input.userId,
      id,
      input.proposalId,
      input.pickId,
      rootRunId,
      input.decision,
      input.requestId,
    ],
  );
  if (!inserted.rowCount) {
    const old = (
      await c.query(
        "SELECT * FROM decision_outcomes WHERE user_id=$1 AND proposal_id=$2",
        [input.userId, input.proposalId],
      )
    ).rows[0];
    if (old.decision !== input.decision || old.root_run_id !== rootRunId)
      throw new DomainConflict("DECISION_OUTCOME_CONFLICT");
    return { id: old.id };
  }
  if (rootRunId)
    await c.query(
      "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'receipt_prepare_decision',$3,$4) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        input.userId,
        id,
        JSON.stringify({ decisionId: id, rootRunId }),
      ],
    );
  return { id };
}
export async function rejectPickProposal(
  pool: Pool,
  userId: string,
  pickId: string,
  input: { proposalId: string; requestId: string; confirmed: true },
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([userId, input.requestId]),
    ]);
    const hash = createHash("sha256")
      .update(JSON.stringify({ kind: "pick.reject", pickId, ...input }))
      .digest("hex");
    const old = (
      await c.query(
        "SELECT request_hash,result FROM mutation_requests WHERE user_id=$1 AND request_id=$2",
        [userId, input.requestId],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash)
        throw new DomainConflict("IDEMPOTENCY_KEY_REUSED");
      await c.query("COMMIT");
      return old.result;
    }
    const proposal = (
      await c.query(
        "SELECT status FROM change_proposals WHERE id=$1 AND user_id=$2 AND pick_id=$3 FOR UPDATE",
        [input.proposalId, userId, pickId],
      )
    ).rows[0];
    if (!proposal) throw Error("NOT_FOUND");
    if (proposal.status !== "pending")
      throw new DomainConflict("PROPOSAL_NOT_PENDING");
    await c.query(
      "UPDATE change_proposals SET status='rejected' WHERE id=$1 AND user_id=$2",
      [input.proposalId, userId],
    );
    const outcome = await recordDecisionOutcome(c, {
      userId,
      proposalId: input.proposalId,
      pickId,
      decision: "rejected",
      requestId: input.requestId,
    });
    const result = {
      proposalId: input.proposalId,
      status: "rejected",
      decisionId: outcome.id,
    };
    await c.query(
      "INSERT INTO mutation_requests(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)",
      [userId, input.requestId, hash, JSON.stringify(result)],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
