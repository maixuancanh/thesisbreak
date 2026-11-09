import { monitoringTransaction } from "./pick-reasons";
import {
  queueDependentReviews,
  propagateAtomWithdrawal,
} from "./decision-dependencies";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  decisionRecapSchema,
  recapResult,
  recapConditionObservation,
  type DecisionRecap,
} from "../../domain/src/decision-recap";
import { storedEventStart } from "./forecast-lock";
const iso = (v: string | Date) => new Date(v).toISOString();
export async function readDecisionRecap(
  pool: Pool,
  ownerId: string,
  pickId: string,
): Promise<DecisionRecap | null> {
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        "SELECT payload FROM decision_recap_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    if (!row) return null;
    const explanation = (
      await c.query(
        "SELECT id,revision,status FROM explanation_reviews WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    return decisionRecapSchema.parse({
      ...row.payload,
      ...(explanation ? { explanationReview: explanation } : {}),
    });
  });
}
/** Snapshot under the pick lock: append a revision only when retained inputs change. */
export async function prepareDecisionRecap(
  pool: Pool,
  ownerId: string,
  pickId: string,
  lease?: { jobId: string; token: string },
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)", [ownerId]);
    if (
      lease &&
      !(
        await c.query(
          "SELECT id FROM learning_jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND state='processing' AND lease_until>clock_timestamp() FOR UPDATE",
          [lease.jobId, ownerId, lease.token],
        )
      ).rowCount
    )
      throw Error("LEASE_LOST");
    const pick = (
      await c.query(
        `SELECT p.id,p.user_id,p.platform,p.native_id,v.version,v.outcome,v.reason,v.created_at,s.raw,s.rules_hash,clock_timestamp() AS known_at FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE p.id=$1 AND p.user_id=$2 ORDER BY v.version ASC LIMIT 1 FOR UPDATE OF p`,
        [pickId, ownerId],
      )
    ).rows[0];
    if (!pick) throw Error("NOT_FOUND");
    const reason = (
      await c.query(
        "SELECT * FROM pick_reason_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY confirmed_at,revision LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    const changes = (
      await c.query(
        "SELECT i.id,i.state,i.payload,i.checked_at,e.published_at,e.observed_at FROM pick_impact_assessments i JOIN source_change_events e ON e.id=i.change_id AND e.user_id=i.user_id WHERE i.user_id=$1 AND i.pick_id=$2 ORDER BY i.checked_at,i.id LIMIT 100",
        [ownerId, pickId],
      )
    ).rows;
    const actions = (
      await c.query(
        "SELECT a.* FROM pick_review_actions a JOIN pick_impact_assessments i ON i.id=a.assessment_id AND i.user_id=a.user_id WHERE a.user_id=$1 AND i.pick_id=$2 ORDER BY a.created_at,a.id LIMIT 100",
        [ownerId, pickId],
      )
    ).rows;
    const result = (
      await c.query(
        "SELECT * FROM confirmed_action_results WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    const previous = (
      await c.query(
        "SELECT * FROM decision_recap_versions WHERE user_id=$1 AND pick_id=$2 ORDER BY revision DESC LIMIT 1",
        [ownerId, pickId],
      )
    ).rows[0];
    const original = reason
      ? (
          await c.query(
            "SELECT v.outcome,v.reason,v.version,v.created_at,s.rules_hash,s.raw FROM pick_versions v LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE v.pick_id=$1 AND v.user_id=$2 AND v.version=$3",
            [pickId, ownerId, reason.pick_version],
          )
        ).rows[0]
      : pick;
    if (!original) throw Error("MISSING_REASON_PICK_VERSION");
    const start = storedEventStart(original.raw);
    const officialResult = recapResult({
      pickOutcome: original.outcome,
      confirmedAt: iso(original.created_at),
      eventStartedAt: start,
      settlement: result
        ? {
            status: result.payload.status,
            winner: result.payload.winner,
            verified: true,
            rulesMatch: result.payload.rulesHash === original.rules_hash,
            sourceUrl: result.payload.sourceUrl,
            observedAt: result.payload.retrievedAt,
            revision: result.revision,
          }
        : null,
    });
    const mappedChanges = changes.map((r) => ({
      id: r.id,
      explanation: r.payload.explanation,
      conditionMet: recapConditionObservation({
        state: r.state,
        evidenceState: r.payload.evidenceState,
        conditionMet: r.payload.conditionMet ?? null,
      }),
      evidenceState: r.payload.evidenceState,
      beforeRefs: r.payload.beforeRefs ?? [],
      afterRefs: r.payload.afterRefs ?? [],
      checkedAt: iso(r.checked_at),
      publishedAt: r.published_at ? iso(r.published_at) : null,
      observedAt: r.observed_at ? iso(r.observed_at) : null,
    }));
    // Unknown checks never become false evidence; true means the recorded condition occurred.
    const conditionOccurred = mappedChanges.some((r) => r.conditionMet === true)
      ? true
      : mappedChanges.length &&
          mappedChanges.every((r) => r.conditionMet === false)
        ? false
        : null;
    const evidenceRefs = [
      ...new Set([
        ...(reason?.payload.evidenceRefs ?? []),
        ...mappedChanges.flatMap((r) => [...r.beforeRefs, ...r.afterRefs]),
        ...(result ? [`action:${pickId}:${result.revision}`] : []),
      ]),
    ];
    const content = {
      ownerId,
      pickId,
      mode: reason?.mode ?? "live",
      initialReason: {
        text: reason?.payload.userText ?? original.reason ?? "",
        reasonId: reason?.id ?? null,
        pickVersion: reason?.pick_version ?? original.version,
        outcome: original.outcome,
        confirmedAt: iso(reason?.confirmed_at ?? original.created_at),
      },
      changes: mappedChanges,
      choices: actions.map((a) => ({
        id: a.id,
        action: a.action,
        confirmedAt: iso(a.created_at),
        afterEvent: start
          ? new Date(a.created_at).getTime() >= Date.parse(start)
          : null,
      })),
      officialResult,
      conditionOccurred,
      eventStartedAt: start,
      evidenceRefs,
    };
    const contentHash = createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
    if (previous?.content_hash === contentHash) {
      await c.query("COMMIT");
      return decisionRecapSchema.parse(previous.payload);
    }
    const recap = decisionRecapSchema.parse({
      ...content,
      id: randomUUID(),
      revision: (previous?.revision ?? 0) + 1,
      predecessorId: previous?.id ?? null,
      recordedAt: iso(pick.known_at),
    });
    await c.query(
      "INSERT INTO decision_recap_versions(id,user_id,pick_id,revision,payload,content_hash,predecessor_id,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        recap.id,
        ownerId,
        pickId,
        recap.revision,
        JSON.stringify(recap),
        contentHash,
        recap.predecessorId,
        recap.mode,
      ],
    );
    if (previous) {
      const atoms = (
        await c.query(
          "UPDATE memory_atoms SET withdrawn_at=clock_timestamp() WHERE user_id=$1 AND payload->>'reference'=$2 AND withdrawn_at IS NULL RETURNING id,version,hash",
          [ownerId, `recap:${previous.id}:${previous.revision}`],
        )
      ).rows;
      for (const atom of atoms) {
        await queueDependentReviews(c, ownerId, {
          ...atom,
          status: "superseded",
        });
        await propagateAtomWithdrawal(c, ownerId, atom.id, "superseded");
      }
    }
    if (recap.officialResult.status === "final" && recap.mode === "live")
      await c.query(
        `INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload)
        SELECT gen_random_uuid()::text,$1,'capture_recap',$2,jsonb_build_object('runId',r.id,'recapId',$3::text)
        FROM agent_runs r JOIN conversations s ON s.id=r.conversation_id AND s.user_id=r.user_id AND s.memory_consent=true
        JOIN action_memory_preferences a ON a.user_id=r.user_id AND a.memory_consent=true
        WHERE r.user_id=$1 AND r.platform=$4 AND r.native_id=$5 AND r.status='completed'
        ORDER BY r.finished_at DESC LIMIT 1 ON CONFLICT(user_id,kind,operation_key) DO NOTHING`,
        [ownerId, `recap:${recap.id}`, recap.id, pick.platform, pick.native_id],
      );
    await c.query("COMMIT");
    return recap;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
