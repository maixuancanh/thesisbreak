import type { Pool } from "pg";
import { z } from "zod";
import { lessonRowToPayload } from "./memory-outbox";
import { reasonReviewSchema } from "../../domain/src/reason-review";
import {
  briefingQuerySchema,
  aggregateHabits,
  selectApplicableLessons,
  type BriefingMarket,
  type ResearchBriefing,
  type LessonHistory,
  type HabitReviewRun,
} from "../../domain/src/research-memory";
const sourcesSchema = z
  .array(z.object({ id: z.string(), url: z.url(), retrievedAt: z.string() }))
  .max(100);
const sources = (value: unknown) => {
  const p = sourcesSchema.safeParse(value);
  return p.success ? p.data : [];
};
const iso = (value: Date) => value.toISOString();
/** A single read-only snapshot keeps current authority and version history consistent. */
export async function readResearchBriefing(
  pool: Pool,
  userId: string,
  market: BriefingMarket,
  scope?: { domain: string; competition?: string; sourceClass?: string },
): Promise<ResearchBriefing> {
  market = briefingQuerySchema.parse(market);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const pick = (
      await c.query(
        `SELECT p.id,p.current_version,v.outcome,v.reason,v.assumptions,v.created_at FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.user_id=$1 AND p.platform=$2 AND p.native_id=$3 ORDER BY p.created_at DESC,p.id LIMIT 1`,
        [userId, market.platform, market.id],
      )
    ).rows[0];
    const run = (
      await c.query(
        `SELECT r.id,r.message,r.result,r.finished_at FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND c.platform=$2 AND c.native_id=$3 AND r.status='completed' ORDER BY r.finished_at DESC,r.id DESC LIMIT 1`,
        [userId, market.platform, market.id],
      )
    ).rows[0];
    const rows = (
      await c.query(
        `SELECT v.*,l.current_version,r.id AS origin_id,r.finished_at AS origin_at,c.platform AS origin_platform,c.native_id AS origin_native_id FROM lessons l JOIN lesson_versions v ON v.lesson_id=l.id AND v.user_id=l.user_id LEFT JOIN agent_runs r ON r.id=v.originating_correction AND r.user_id=l.user_id AND r.status='completed' LEFT JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE l.user_id=$1 ORDER BY (v.version=l.current_version) DESC,l.id,v.version DESC LIMIT 2000`,
        [userId],
      )
    ).rows;
    const lessonHistory: LessonHistory[] = rows.map((r) => ({
      currentVersion: r.current_version,
      lesson: lessonRowToPayload(r),
      origin:
        r.origin_id && r.origin_platform
          ? {
              runId: r.origin_id,
              platform: r.origin_platform,
              nativeId: r.origin_native_id,
              recordedAt: iso(r.origin_at),
            }
          : null,
    }));
    const now = new Date();
    const result: ResearchBriefing = {
      schemaVersion: 1,
      market,
      generatedAt: now.toISOString(),
      contextStatus: "recorded",
      currentPick: pick
        ? {
            id: pick.id,
            version: pick.current_version,
            outcome: pick.outcome,
            reason: pick.reason,
            assumptions: Array.isArray(pick.assumptions)
              ? pick.assumptions.slice(0, 20)
              : [],
            recordedAt: iso(pick.created_at),
          }
        : null,
      lastConversation: run
        ? {
            runId: run.id,
            message: run.message.slice(0, 4000),
            reply:
              typeof run.result?.reply?.message === "string"
                ? run.result.reply.message.slice(0, 12000)
                : "",
            recordedAt: iso(run.finished_at),
            sources: sources(run.result?.sources),
          }
        : null,
      applicableLessons: scope
        ? selectApplicableLessons(lessonHistory, { ...scope, userId, now })
        : [],
      lessonHistory,
    };
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
export async function readHabitReview(pool: Pool, userId: string) {
  // A review is linked only when its claimed version exists on an owned pick in the same native market.
  const rows = (
    await pool.query(
      `SELECT r.id,r.user_id,r.result,r.finished_at,c.platform,c.native_id,p.id AS pick_id,v.version FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id JOIN picks p ON p.user_id=r.user_id AND p.platform=c.platform AND p.native_id=c.native_id JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version::text=r.result->'reply'->'reasonReview'->>'baseVersion' WHERE r.user_id=$1 AND r.status='completed' AND v.created_at<=r.created_at ORDER BY r.finished_at DESC,r.id DESC LIMIT 500`,
      [userId],
    )
  ).rows;
  const runs: HabitReviewRun[] = [];
  for (const row of rows) {
    const review = reasonReviewSchema.safeParse(
      row.result?.reply?.reasonReview,
    );
    if (!review.success) continue;
    runs.push({
      userId: row.user_id,
      platform: row.platform,
      nativeId: row.native_id,
      runId: row.id,
      pickId: row.pick_id,
      pickVersion: row.version,
      recordedAt: iso(row.finished_at),
      claims: review.data.claims,
      sources: sources(row.result?.sources),
    });
  }
  return { ...aggregateHabits(runs, userId), historyLimit: 500 };
}
