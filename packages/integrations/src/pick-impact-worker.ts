import { upsertReviewCaseFromAssessment } from "../../db/src/review-cases";
import { saveDecisionEvidenceAssessmentInTransaction } from "../../db/src/decision-evidence-assessments";
import { readRecordedDecisionQuotes } from "../../db/src/decision-quote-snapshots";
import {
  assessDecisionEvidence,
  selectDecisionQuoteSnapshots,
} from "../../agent/src/decision-evidence-assessment";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claimLearningJob } from "../../db/src/learning-jobs";
import { reasonVersionSchema } from "../../domain/src/pick-reason";
import {
  assessPickCondition,
  PICK_IMPACT_RULES_VERSION,
} from "../../agent/src/pick-impact-assessor";
/** One source change, bounded fanout. Source snapshots are untrusted text, never structured official fields. */
export async function runOnePickImpactJob(pool: Pool) {
  const token = randomUUID();
  const job = await claimLearningJob(pool, {
    kinds: ["pick_impact"],
    token,
    leaseSeconds: 30,
  });
  if (!job) return { checked: 0, completed: 0, assessed: 0 };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id',$1,true)", [job.user_id]);
    const lease = (
      await c.query(
        "SELECT id FROM learning_jobs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE",
        [job.id, token],
      )
    ).rows[0];
    if (!lease) throw Error("LEASE_LOST");
    const event = (
      await c.query(
        "SELECT e.*,e.observed_at::text AS observed_time,w.event_id,w.dependency_id,w.state AS watch_state,w.expires_at,w.last_error FROM source_change_events e JOIN source_watches w ON w.id=e.watch_id AND w.user_id=e.user_id WHERE e.id=$1 AND e.user_id=$2 FOR SHARE OF w",
        [job.payload.changeId, job.user_id],
      )
    ).rows[0];
    if (!event) throw Error("SOURCE_CHANGE_NOT_FOUND");
    const rows = (
      await c.query(
        `SELECT b.id AS binding_id,b.condition_index,r.*,r.payload AS reason FROM pick_watch_bindings b JOIN pick_reason_versions r ON r.id=b.reason_id AND r.user_id=b.user_id JOIN picks p ON p.id=r.pick_id AND p.user_id=r.user_id AND p.current_version=r.pick_version JOIN action_memory_preferences m ON m.user_id=b.user_id AND m.memory_consent WHERE b.user_id=$1 AND b.watch_id=$2 AND b.state='active' AND r.revision=(SELECT max(x.revision) FROM pick_reason_versions x WHERE x.user_id=r.user_id AND x.pick_id=r.pick_id AND x.pick_version=r.pick_version) AND NOT EXISTS(SELECT 1 FROM pick_impact_assessments a WHERE a.user_id=b.user_id AND a.change_id=$3 AND a.reason_id=r.id AND a.rules_version=$4) AND r.id IN (SELECT DISTINCT x.reason_id FROM pick_watch_bindings x JOIN pick_reason_versions xr ON xr.id=x.reason_id AND xr.user_id=x.user_id JOIN picks xp ON xp.id=xr.pick_id AND xp.user_id=xr.user_id AND xp.current_version=xr.pick_version JOIN action_memory_preferences xm ON xm.user_id=x.user_id AND xm.memory_consent WHERE x.user_id=$1 AND x.watch_id=$2 AND x.state='active' AND xr.revision=(SELECT max(latest.revision) FROM pick_reason_versions latest WHERE latest.user_id=xr.user_id AND latest.pick_id=xr.pick_id AND latest.pick_version=xr.pick_version) AND NOT EXISTS(SELECT 1 FROM pick_impact_assessments done WHERE done.user_id=x.user_id AND done.change_id=$3 AND done.reason_id=x.reason_id AND done.rules_version=$4) AND ($5::text IS NULL OR x.reason_id>$5) ORDER BY x.reason_id LIMIT 100) ORDER BY r.id,b.id FOR SHARE OF b,p,m`,
        [
          job.user_id,
          event.watch_id,
          event.id,
          PICK_IMPACT_RULES_VERSION,
          job.payload.afterReasonId ?? null,
        ],
      )
    ).rows;
    const batchIds = [...new Set(rows.map((r) => r.id as string))];
    let assessed = 0;
    if (
      event.watch_state === "active" &&
      new Date(event.expires_at).getTime() > Date.now()
    ) {
      const reasons = new Map<string, (typeof rows)[number]>();
      for (const row of rows) reasons.set(row.id, row);
      for (const row of reasons.values()) {
        const reason = reasonVersionSchema.parse(row.reason);
        const conditions = rows
          .filter((r) => r.id === row.id)
          .map((r) => reason.conditions[r.condition_index])
          .filter(
            (value): value is NonNullable<typeof value> => value !== undefined,
          );
        const results = conditions
          .map((condition) =>
            assessPickCondition({
              condition,
              eventId: event.event_id,
              observedAt: event.observed_time,
              sourceAvailable: event.source_available !== false,
              before: event.before_value,
              after: event.after_value,
              referenceId: event.dependency_id,
              ...(event.after_structured_evidence
                ? { structured: event.after_structured_evidence }
                : {}),
            }),
          )
          .filter((r) => r.inScope);
        if (!results.length) continue;
        const priority = [
          "needs_review",
          "check_unavailable",
          "waiting_confirmation",
          "still_watching",
        ];
        const result = results.sort(
          (a, b) => priority.indexOf(a.state) - priority.indexOf(b.state),
        )[0]!;
        const id = randomUUID();
        if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true") {
          const checkedAt = new Date().toISOString();
          const triggerObservedAt = new Date(event.observed_at).toISOString();
          const quotes = await readRecordedDecisionQuotes(
            c,
            job.user_id,
            reason.pickId,
            triggerObservedAt,
            checkedAt,
          );
          result.decisionEvidence = assessDecisionEvidence({
            reasonImpact: result.decisionEvidence.reasonImpact,
            ...selectDecisionQuoteSnapshots({
              quotes,
              triggerObservedAt,
              now: checkedAt,
            }),
            triggerObservedAt,
            observedAt: checkedAt,
            challenger: null,
          });
        }
        const payload = {
          ...result,
          id,
          changeId: event.id,
          pickId: reason.pickId,
          pickVersion: reason.pickVersion,
          reasonId: reason.id,
          reasonRevision: reason.revision,
          beforeRefs: [`source-change:${event.id}:before:${event.before_hash}`],
          afterRefs: [`source-change:${event.id}:after:${event.after_hash}`],
          beforeExcerpt: event.before_value.slice(0, 2000),
          afterExcerpt: event.after_value.slice(0, 2000),
        };
        await c.query(
          "INSERT INTO pick_impact_assessments(id,user_id,change_id,reason_id,reason_revision,pick_id,pick_version,rules_version,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
          [
            id,
            job.user_id,
            event.id,
            reason.id,
            reason.revision,
            reason.pickId,
            reason.pickVersion,
            PICK_IMPACT_RULES_VERSION,
            result.state,
            JSON.stringify(payload),
          ],
        );
        if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true") {
          const persisted = (
            await c.query(
              "SELECT id FROM pick_impact_assessments WHERE user_id=$1 AND change_id=$2 AND reason_id=$3 AND rules_version=$4",
              [job.user_id, event.id, reason.id, PICK_IMPACT_RULES_VERSION],
            )
          ).rows[0];
          if (persisted) {
            const caseId = await upsertReviewCaseFromAssessment(
              c,
              job.user_id,
              persisted.id,
            );
            if (caseId) {
              const reviewCase = (
                await c.query(
                  "SELECT revision FROM review_cases WHERE id=$1 AND user_id=$2",
                  [caseId, job.user_id],
                )
              ).rows[0];
              await saveDecisionEvidenceAssessmentInTransaction(
                c,
                job.user_id,
                {
                  caseId,
                  caseRevision: reviewCase.revision,
                  pickId: reason.pickId,
                  pickVersion: reason.pickVersion,
                  reasonId: reason.id,
                  reasonVersion: reason.revision,
                  assessment: result.decisionEvidence,
                },
              );
            }
          }
        }
        await c.query(
          "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'decision_recap',$3,$4) ON CONFLICT DO NOTHING",
          [
            randomUUID(),
            job.user_id,
            `impact:${id}`,
            JSON.stringify({ pickId: reason.pickId }),
          ],
        );
        if (
          result.state === "waiting_confirmation" &&
          event.source_available !== false
        )
          await c.query(
            "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'pick_impact_prose',$3,$4) ON CONFLICT DO NOTHING",
            [
              randomUUID(),
              job.user_id,
              `prose:${event.id}:${reason.id}:${reason.revision}`,
              JSON.stringify({ assessmentId: id }),
            ],
          );
        assessed++;
      }
    }
    await c.query(
      "UPDATE learning_jobs SET state=$3,lease_until=NULL,last_error=NULL,retry_at=clock_timestamp(),payload=$4,attempts=CASE WHEN $3='retry' THEN greatest(attempts-1,0) ELSE attempts END WHERE id=$1 AND lease_token=$2",
      [
        job.id,
        token,
        batchIds.length === 100 ? "retry" : "completed",
        JSON.stringify({
          ...job.payload,
          afterReasonId: batchIds.at(-1) ?? job.payload.afterReasonId ?? null,
        }),
      ],
    );
    await c.query("COMMIT");
    return { checked: 1, completed: batchIds.length === 100 ? 0 : 1, assessed };
  } catch {
    await c.query("ROLLBACK");
    await pool.query(
      "UPDATE learning_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,retry_at=clock_timestamp()+interval '5 minutes',lease_until=NULL,last_error='PICK_IMPACT_FAILED' WHERE id=$1 AND lease_token=$2",
      [job.id, token],
    );
    return { checked: 1, completed: 0, assessed: 0 };
  } finally {
    c.release();
  }
}
