import type { Pool } from "pg";
/** Historical usage, not proof that a prediction was correct or that memory caused improvement. */
export async function readWeeklyReview(pool: Pool, userId: string) {
  const counts = await pool.query(
    `SELECT
 (SELECT count(*)::int FROM picks WHERE user_id=$1 AND created_at>=now()-interval '7 days') AS picks,
 (SELECT count(*)::int FROM agent_runs WHERE user_id=$1 AND status='completed' AND created_at>=now()-interval '7 days') AS runs,
 (SELECT count(*)::int FROM lesson_versions WHERE user_id=$1 AND version=1 AND effective_at>=now()-interval '7 days') AS lessons`,
    [userId],
  );
  const used = await pool.query(
    `SELECT item->>'id' AS id,item->>'rule' AS rule,count(*)::int AS uses FROM agent_runs r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.result->'usedLessons')='array' THEN r.result->'usedLessons' ELSE '[]'::jsonb END) item WHERE r.user_id=$1 AND r.status='completed' AND r.created_at>=now()-interval '7 days' GROUP BY item->>'id',item->>'rule' ORDER BY uses DESC,id LIMIT 50`,
    [userId],
  );
  return {
    period: "Last seven days",
    picksRecorded: counts.rows[0].picks as number,
    conversationsReviewed: counts.rows[0].runs as number,
    preferencesApproved: counts.rows[0].lessons as number,
    preferenceUses: used.rows.reduce((sum, r) => sum + Number(r.uses), 0),
    usedPreferences: used.rows.map((r) => ({
      id: String(r.id),
      rule: String(r.rule),
      uses: Number(r.uses),
    })),
  };
}
