import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { monitoringTransaction } from "./pick-reasons";
import { DomainConflict } from "../../domain/src/index";

const followupAction = z
  .object({
    caseRevision: z.number().int().positive(),
    action: z.enum(["acknowledge", "snooze", "stop"]),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    timezone: z.string().max(100).default("UTC"),
  })
  .strict();

/** Call in the same transaction as case materialization. No external notifications. */
export async function queueCaseFollowups(
  c: PoolClient,
  ownerId: string,
  caseId: string,
) {
  await c.query(
    `UPDATE review_followups f SET state='superseded',updated_at=clock_timestamp()
    FROM review_cases rc WHERE rc.id=$2 AND rc.user_id=$1 AND f.case_id=rc.id AND f.user_id=$1
    AND f.case_revision<>rc.revision AND f.state IN ('pending','snoozed')`,
    [ownerId, caseId],
  );
  return (
    await c.query(
      `INSERT INTO review_followups
    (id,user_id,case_id,case_revision,pick_id,pick_version,reason_id,reason_version,state,due_at,timezone,payload)
    SELECT $3 || ':' || l.pick_id || ':' || l.reason_id,l.user_id,l.case_id,rc.revision,
    l.pick_id,l.pick_version,l.reason_id,l.reason_version,CASE WHEN prior.due_at>clock_timestamp() THEN 'snoozed' ELSE 'pending' END,CASE WHEN prior.due_at>clock_timestamp() THEN prior.due_at ELSE NULL END,COALESCE(prior.timezone,'UTC'),'{}'::jsonb
    FROM review_case_picks l JOIN review_cases rc ON rc.id=l.case_id AND rc.user_id=l.user_id
    JOIN picks p ON p.id=l.pick_id AND p.user_id=l.user_id AND p.current_version=l.pick_version
    LEFT JOIN LATERAL(SELECT f.due_at,f.timezone FROM review_followups f WHERE f.user_id=l.user_id AND f.case_id=l.case_id AND f.pick_id=l.pick_id AND f.reason_id=l.reason_id AND f.reason_version=l.reason_version AND f.case_revision<rc.revision ORDER BY f.case_revision DESC LIMIT 1) prior ON true
    WHERE l.user_id=$1 AND l.case_id=$2 AND l.disposition='pending'
    AND NOT EXISTS(SELECT 1 FROM review_followups ack WHERE ack.user_id=l.user_id AND ack.case_id=l.case_id AND ack.pick_id=l.pick_id AND ack.reason_id=l.reason_id AND ack.reason_version=l.reason_version AND ack.state='acknowledged')
    AND NOT EXISTS(SELECT 1 FROM review_followups s WHERE s.user_id=l.user_id
      AND s.pick_id=l.pick_id AND s.state='stopped')
    AND NOT EXISTS(SELECT 1 FROM pick_review_actions a WHERE a.user_id=l.user_id AND a.assessment_id=l.assessment_id)
    ON CONFLICT(user_id,case_id,case_revision,pick_id,reason_id,reason_version,channel) DO NOTHING RETURNING id`,
      [ownerId, caseId, randomUUID()],
    )
  ).rows;
}

export async function setReviewFollowup(
  pool: Pool,
  ownerId: string,
  id: string,
  raw: unknown,
) {
  const v = followupAction.parse(raw);
  try {
    new Intl.DateTimeFormat("en", { timeZone: v.timezone });
  } catch {
    throw Error("INVALID_TIMEZONE");
  }
  return monitoringTransaction(pool, ownerId, async (c) => {
    const row = (
      await c.query(
        `SELECT f.*,rc.revision AS current_revision,clock_timestamp() AS now
      FROM review_followups f JOIN review_cases rc ON rc.id=f.case_id AND rc.user_id=f.user_id
      WHERE f.id=$1 AND f.user_id=$2 FOR UPDATE OF f,rc`,
        [id, ownerId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    if (
      row.case_revision !== v.caseRevision ||
      row.current_revision !== v.caseRevision
    )
      throw new DomainConflict("STALE_REVIEW");
    if (row.state === "stopped" && v.action !== "stop")
      throw new DomainConflict("FOLLOWUP_STOPPED");
    if (
      v.action === "snooze" &&
      (!v.dueAt ||
        Date.parse(v.dueAt) <= new Date(row.now).getTime() ||
        Date.parse(v.dueAt) > new Date(row.now).getTime() + 7 * 86400000)
    )
      throw Error("INVALID_SNOOZE");
    if (v.action === "stop") {
      await c.query(
        `UPDATE pick_watch_bindings b SET state='paused' FROM pick_reason_versions r
        WHERE b.reason_id=r.id AND b.user_id=$1 AND r.user_id=$1 AND r.pick_id=$2`,
        [ownerId, row.pick_id],
      );
      await c.query(
        `UPDATE review_followups SET state='stopped',updated_at=clock_timestamp()
        WHERE user_id=$1 AND pick_id=$2 AND state IN ('pending','snoozed','acknowledged')`,
        [ownerId, row.pick_id],
      );
    }
    return (
      await c.query(
        `UPDATE review_followups SET state=$3,due_at=$4,timezone=$5,
      updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING *`,
        [
          id,
          ownerId,
          v.action === "stop"
            ? "stopped"
            : v.action === "acknowledge"
              ? "acknowledged"
              : "snoozed",
          v.action === "snooze" ? v.dueAt : null,
          v.timezone,
        ],
      )
    ).rows[0];
  });
}

/** An in-app inbox read is the delivery; recheck current state on every read. */
export async function listReviewFollowups(pool: Pool, ownerId: string) {
  return monitoringTransaction(
    pool,
    ownerId,
    async (c) =>
      (
        await c.query(
          `SELECT f.* FROM review_followups f
    JOIN review_cases rc ON rc.id=f.case_id AND rc.user_id=f.user_id AND rc.revision=f.case_revision
    JOIN picks p ON p.id=f.pick_id AND p.user_id=f.user_id AND p.current_version=f.pick_version
    JOIN review_case_picks l ON l.case_id=f.case_id AND l.user_id=f.user_id AND l.pick_id=f.pick_id AND l.reason_id=f.reason_id
    WHERE f.user_id=$1 AND l.disposition='pending' AND f.state IN ('pending','snoozed') AND (f.due_at IS NULL OR f.due_at<=clock_timestamp())
    AND EXISTS(SELECT 1 FROM action_memory_preferences a WHERE a.user_id=f.user_id AND a.memory_consent)
    AND NOT EXISTS(SELECT 1 FROM pick_review_actions a WHERE a.user_id=f.user_id AND a.assessment_id=l.assessment_id)
    AND EXISTS(SELECT 1 FROM pick_watch_bindings b JOIN source_watches w ON w.id=b.watch_id AND w.user_id=b.user_id JOIN source_change_events sc ON sc.watch_id=w.id AND sc.user_id=w.user_id WHERE sc.id=rc.trigger_evidence_revision_id AND b.user_id=f.user_id AND b.reason_id=f.reason_id AND b.state='active' AND w.state='active' AND w.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM pick_reason_versions newer WHERE newer.user_id=f.user_id AND newer.pick_id=f.pick_id AND newer.pick_version=f.pick_version AND newer.revision>f.reason_version)
    ORDER BY f.created_at,f.id LIMIT 100`,
          [ownerId],
        )
      ).rows,
  );
}
