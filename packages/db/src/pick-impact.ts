import { closeReviewCasePick } from "./review-cases";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import {
  monitoringTransaction,
  monitoringReplay,
  saveMonitoringRequest,
} from "./pick-reasons";
import { DomainConflict } from "../../domain/src/index";
export const pickReviewActionSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    assessmentId: z.string().min(1).max(300),
    basePickVersion: z.number().int().positive(),
    reasonRevision: z.number().int().positive(),
    action: z.enum(["keep", "update", "stop_watching"]),
    confirmed: z.literal(true),
    note: z.string().max(2000).optional(),
  })
  .strict();
export async function recordPickReviewAction(
  pool: Pool,
  userId: string,
  reviewId: string,
  raw: unknown,
) {
  const v = pickReviewActionSchema.parse(raw);
  if (v.assessmentId !== reviewId) throw Error("ASSESSMENT_MISMATCH");
  return monitoringTransaction(pool, userId, async (c) => {
    const replay = await monitoringReplay(c, userId, v.requestId, {
      kind: "pick.review.action",
      reviewId,
      ...v,
    });
    if (replay.old) return replay.old;
    const row = (
      await c.query(
        "SELECT a.*,p.current_version FROM pick_impact_assessments a JOIN picks p ON p.id=a.pick_id AND p.user_id=a.user_id WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF p",
        [reviewId, userId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    if (
      row.current_version !== row.pick_version ||
      row.current_version !== v.basePickVersion ||
      row.reason_revision !== v.reasonRevision
    )
      throw new DomainConflict("STALE_REVIEW");
    if (
      (
        await c.query(
          "SELECT id FROM pick_review_actions WHERE user_id=$1 AND assessment_id=$2 AND action IN ('keep','update','stop_watching') LIMIT 1",
          [userId, reviewId],
        )
      ).rows[0]
    )
      throw new DomainConflict("REVIEW_ALREADY_CLOSED");
    const newestAssessment = (
      await c.query(
        "SELECT id FROM pick_impact_assessments WHERE user_id=$1 AND reason_id=$2 AND change_id=$3 ORDER BY checked_at DESC,id DESC LIMIT 1",
        [userId, row.reason_id, row.change_id],
      )
    ).rows[0];
    if (newestAssessment?.id !== reviewId)
      throw new DomainConflict("STALE_REVIEW");
    const latest = (
      await c.query(
        "SELECT max(revision) AS revision FROM pick_reason_versions WHERE user_id=$1 AND pick_id=$2 AND pick_version=$3",
        [userId, row.pick_id, row.pick_version],
      )
    ).rows[0];
    if (latest.revision !== row.reason_revision)
      throw new DomainConflict("STALE_REASON");
    const consent =
      (
        await c.query(
          "SELECT memory_consent FROM action_memory_preferences WHERE user_id=$1 FOR SHARE",
          [userId],
        )
      ).rows[0]?.memory_consent === true;
    if (!consent && v.action !== "stop_watching")
      throw new DomainConflict("MONITORING_CONSENT_REQUIRED");
    if (v.action === "update") {
      await c.query(
        "INSERT INTO pick_review_proposals(user_id,assessment_id,request_id) VALUES($1,$2,$3) ON CONFLICT(user_id,assessment_id) DO UPDATE SET request_id=EXCLUDED.request_id,proposal_id=NULL WHERE pick_review_proposals.proposal_id IS NULL OR EXISTS(SELECT 1 FROM change_proposals cp WHERE cp.id=pick_review_proposals.proposal_id AND (cp.status<>'pending' OR cp.expires_at<=clock_timestamp()))",
        [userId, reviewId, v.requestId],
      );
      const result = {
        action: v.action,
        assessmentId: reviewId,
        pickId: row.pick_id,
        status: "proposal_required",
      };
      await saveMonitoringRequest(
        c,
        userId,
        v.requestId,
        replay.digest,
        result,
      );
      return result;
    }
    if (v.action === "stop_watching")
      await c.query(
        "UPDATE pick_watch_bindings b SET state='paused' FROM pick_reason_versions r WHERE r.id=b.reason_id AND b.user_id=$1 AND r.pick_id=$2",
        [userId, row.pick_id],
      );
    await c.query(
      "INSERT INTO pick_review_actions(id,user_id,assessment_id,request_id,action,payload) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        userId,
        reviewId,
        v.requestId,
        v.action,
        JSON.stringify(v),
      ],
    );
    if (process.env.THESISBREAK_ACCOUNTABILITY_ENABLED === "true")
      await closeReviewCasePick(
        c,
        userId,
        reviewId,
        v.action === "stop_watching" ? "stopped" : "kept",
      );
    await c.query(
      "INSERT INTO learning_jobs(id,user_id,kind,operation_key,payload) VALUES($1,$2,'decision_recap',$3,$4) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        userId,
        `review-action:${reviewId}:${v.requestId}`,
        JSON.stringify({ pickId: row.pick_id }),
      ],
    );
    const result = {
      action: v.action,
      assessmentId: reviewId,
      status: "recorded",
    };
    await saveMonitoringRequest(c, userId, v.requestId, replay.digest, result);
    return result;
  });
}
export async function listPickReviews(
  pool: Pool,
  userId: string,
  options: { cursor?: string | undefined; reviewId?: string | undefined } = {},
) {
  return monitoringTransaction(pool, userId, async (c) => {
    let cursor: { time: string; id: string } | null = null;
    if (options.cursor) {
      try {
        cursor = z
          .object({ time: z.string().max(64), id: z.string().max(300) })
          .strict()
          .parse(
            JSON.parse(Buffer.from(options.cursor, "base64url").toString()),
          );
      } catch {
        throw Error("INVALID_CURSOR");
      }
    }
    const rows = (
      await c.query(
        `SELECT a.id,a.change_id,a.pick_id,a.pick_version,a.reason_revision,a.state,a.payload,a.checked_at::text AS cursor_time,a.checked_at,r.payload AS reason,s.question,w.url,EXISTS(SELECT 1 FROM pick_review_actions x WHERE x.user_id=a.user_id AND x.assessment_id=a.id AND x.action IN ('keep','update','stop_watching')) AS closed,(SELECT count(DISTINCT x.pick_id)::int FROM pick_impact_assessments x JOIN picks xp ON xp.id=x.pick_id AND xp.user_id=x.user_id AND xp.current_version=x.pick_version JOIN pick_reason_versions xr ON xr.id=x.reason_id AND xr.user_id=x.user_id WHERE x.user_id=a.user_id AND x.change_id=a.change_id AND x.state=a.state AND NOT EXISTS(SELECT 1 FROM pick_impact_assessments nx WHERE nx.user_id=x.user_id AND nx.reason_id=x.reason_id AND nx.change_id=x.change_id AND (nx.checked_at,nx.id)>(x.checked_at,x.id)) AND xr.revision=(SELECT max(rr.revision) FROM pick_reason_versions rr WHERE rr.user_id=xr.user_id AND rr.pick_id=xr.pick_id AND rr.pick_version=xr.pick_version) AND NOT EXISTS(SELECT 1 FROM pick_review_actions xa WHERE xa.user_id=x.user_id AND xa.assessment_id=x.id)) AS affected_count FROM pick_impact_assessments a JOIN pick_reason_versions r ON r.id=a.reason_id AND r.user_id=a.user_id JOIN picks p ON p.id=a.pick_id AND p.user_id=a.user_id JOIN pick_versions pv ON pv.pick_id=p.id AND pv.version=a.pick_version LEFT JOIN market_snapshots s ON s.id=pv.snapshot_id JOIN source_change_events e ON e.id=a.change_id JOIN source_watches w ON w.id=e.watch_id WHERE a.user_id=$1 AND NOT EXISTS(SELECT 1 FROM pick_impact_assessments newer WHERE newer.user_id=a.user_id AND newer.reason_id=a.reason_id AND newer.change_id=a.change_id AND (newer.checked_at,newer.id)>(a.checked_at,a.id)) AND (a.state<>'check_unavailable' OR w.last_error IS NOT NULL OR a.payload->>'errorCode' IN ('MODEL_TIMEOUT','MODEL_UNAVAILABLE')) AND p.current_version=a.pick_version AND r.revision=(SELECT max(rv.revision) FROM pick_reason_versions rv WHERE rv.user_id=r.user_id AND rv.pick_id=r.pick_id AND rv.pick_version=r.pick_version) AND ($2::text IS NULL OR (a.checked_at,a.id)<($2::timestamptz,$3::text)) AND ($4::text IS NULL OR a.id=$4) ORDER BY a.checked_at DESC,a.id DESC LIMIT 21`,
        [
          userId,
          cursor?.time ?? null,
          cursor?.id ?? null,
          options.reviewId ?? null,
        ],
      )
    ).rows;
    const page = rows.slice(0, 20);
    const last = page.at(-1);
    const coverage = (
      await c.query(
        "SELECT count(*)::int AS total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM pick_reason_versions r JOIN pick_watch_bindings b ON b.reason_id=r.id AND b.state='active' JOIN source_watches w ON w.id=b.watch_id AND w.state='active' AND w.expires_at>clock_timestamp() WHERE r.pick_id=p.id AND r.user_id=p.user_id AND r.pick_version=p.current_version AND EXISTS(SELECT 1 FROM action_memory_preferences m WHERE m.user_id=p.user_id AND m.memory_consent)))::int AS tracked,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM pick_reason_versions r WHERE r.pick_id=p.id AND r.user_id=p.user_id AND r.pick_version=p.current_version))::int AS unconfigured FROM picks p WHERE p.user_id=$1",
        [userId],
      )
    ).rows[0];
    const checked = (
      await c.query(
        "SELECT max(last_success_at) AS t FROM source_watches WHERE user_id=$1",
        [userId],
      )
    ).rows[0].t;
    return {
      items: page.map((r) => ({
        ...r.payload,
        id: r.id,
        changeId: r.change_id,
        pickId: r.pick_id,
        pickVersion: r.pick_version,
        reasonRevision: r.reason_revision,
        state: r.state,
        checkedAt: r.checked_at,
        question: r.question ?? "Your pick",
        userText: r.reason.userText,
        sourceUrl: r.url,
        affectedPickCount: r.affected_count,
        closed: r.closed,
      })),
      nextCursor:
        rows.length > 20 && last
          ? Buffer.from(
              JSON.stringify({ time: last.cursor_time, id: last.id }),
            ).toString("base64url")
          : null,
      coverage: {
        trackedPicks: coverage.tracked,
        totalPicks: coverage.total,
        unconfiguredPicks: coverage.unconfigured,
      },
      lastCheckedAt: checked,
    };
  });
}
