import type { Pool } from "pg";
import { z } from "zod";
import type { ResearchSource } from "../../agent/src/runtime";
const source = z
  .object({
    id: z.string().min(1),
    text: z.string().max(12000),
    retrievedAt: z.iso.datetime({ offset: true }),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
    sourceOrigin: z.string(),
    origin: z.enum(["tool_result", "verified_outcome"]),
  })
  .passthrough();
/** System-known time is the completed original run, never a later summary or remote inclusion timestamp. */
export async function readHistoricalResearchEvidence(
  pool: Pick<Pool, "query">,
  input: {
    userId: string;
    platform: "kalshi" | "polymarket";
    nativeId: string;
    cutoff: Date;
  },
): Promise<ResearchSource[]> {
  if (!Number.isFinite(input.cutoff.getTime()))
    throw Error("INVALID_HISTORICAL_CUTOFF");
  const rows = (
    await pool.query(
      `SELECT r.id,r.created_at,r.message,r.finished_at,r.result->'learningEvidence' evidence FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.platform=$2 AND r.native_id=$3 AND r.status='completed' AND r.finished_at<=$4 AND c.memory_consent=true ORDER BY r.finished_at DESC,r.id DESC LIMIT 20`,
      [input.userId, input.platform, input.nativeId, input.cutoff],
    )
  ).rows;
  const evidence: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (evidence.length >= 14) return evidence;
    if (
      typeof row.message === "string" &&
      row.message.length <= 4000 &&
      Date.parse(row.created_at) <= input.cutoff.getTime()
    )
      evidence.push({
        id: `historical-user:${row.id}`,
        text: JSON.stringify({
          origin: "original_user_statement",
          statement: row.message,
          systemRecordedAt: new Date(row.created_at).toISOString(),
          publicationTime: null,
          note: "User reasoning only, not independent evidence or current permission.",
        }),
        url: "",
        kind: "background",
        publishedAt: null,
        retrievedAt: new Date(row.created_at).toISOString(),
        historicalOrigin: "user_statement",
        historicalKnownAt: new Date(row.created_at).toISOString(),
      });
    for (const value of Array.isArray(row.evidence) ? row.evidence : []) {
      const parsed = source.safeParse(value);
      if (!parsed.success) continue;
      const s = parsed.data;
      if (
        s.publishedAt === null ||
        Date.parse(s.publishedAt) > input.cutoff.getTime() ||
        Date.parse(s.retrievedAt) > input.cutoff.getTime()
      )
        continue;
      const key = JSON.stringify([s.id, s.text, s.publishedAt, s.retrievedAt]);
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        id: `historical:${row.id}:${s.id}`.slice(0, 256),
        text: s.text,
        retrievedAt: s.retrievedAt,
        publishedAt: s.publishedAt,
        url: "",
        kind: s.origin === "verified_outcome" ? "settlement" : "background",
      });
      if (evidence.length === 14) return evidence;
    }
  }
  return evidence;
}
