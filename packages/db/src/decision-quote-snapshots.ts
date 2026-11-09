import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { observedDecisionQuoteSchema } from "../../domain/src/decision-evidence-assessment";
const publicSnapshot = z.object({
  platform: z.enum(["kalshi", "polymarket"]),
  id: z.string().min(1).max(128),
  eventId: z.string().nullable(),
  question: z.string().min(1).max(4000),
  outcomes: z
    .array(
      z.object({
        name: z.string(),
        price: z.number().min(0).max(1).nullable(),
      }),
    )
    .min(2)
    .max(30),
  rules: z.string().min(1).max(20000),
  sourceUrl: z.url(),
  fetchedAt: z.iso.datetime({ offset: true }),
  closeTime: z.string().nullable(),
  decisionQuotes: z.array(observedDecisionQuoteSchema).max(30),
});
/** Reuses recorded market snapshots; never fetches historical quotes or creates a pre-trigger observation. */
export async function recordPublicDecisionQuoteSnapshot(
  pool: Pool,
  value: unknown,
) {
  const parsed = publicSnapshot.safeParse(value);
  if (!parsed.success || !parsed.data.decisionQuotes.length) return false;
  const s = parsed.data,
    rulesHash = createHash("sha256").update(s.rules).digest("hex");
  if (
    s.decisionQuotes.some(
      (q) =>
        q.marketId !== s.id ||
        q.rulesHash !== rulesHash ||
        q.observedAt !== s.fetchedAt ||
        q.provider !== `${s.platform}-public`,
    )
  )
    return false;
  const snapshotId = `quote-snapshot:${createHash("sha256")
    .update(JSON.stringify([s.platform, s.id, s.fetchedAt, s.decisionQuotes]))
    .digest("hex")}`;
  await pool.query(
    "INSERT INTO markets(platform,native_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [s.platform, s.id],
  );
  await pool.query(
    `INSERT INTO market_snapshots(id,platform,native_id,event_id,question,outcomes,rules_reference,rules_hash,close_time,fetched_at,price_as_of,native_unit,raw)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'probability',$11) ON CONFLICT(id) DO NOTHING`,
    [
      snapshotId,
      s.platform,
      s.id,
      s.eventId,
      s.question,
      JSON.stringify(s.outcomes),
      s.sourceUrl,
      rulesHash,
      s.closeTime,
      s.fetchedAt,
      JSON.stringify({
        decisionQuotes: s.decisionQuotes,
        quoteAdapterVersion: "kalshi-book-v1",
      }),
    ],
  );
  return true;
}
/** Identity/outcome binding comes from the current owned pick, not from model text. */
export async function readRecordedDecisionQuotes(
  c: PoolClient,
  ownerId: string,
  pickId: string,
  triggerObservedAt: string,
  now: string,
) {
  const rows = (
    await c.query(
      `SELECT s.raw,s.rules_hash,p.native_id,v.outcome FROM picks p
    JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version
    JOIN market_snapshots s ON s.platform=p.platform AND s.native_id=p.native_id
    WHERE p.id=$1 AND p.user_id=$2 AND s.fetched_at<=$4::timestamptz
      AND s.fetched_at>=$3::timestamptz-interval '1 hour'
      AND s.raw ? 'decisionQuotes' ORDER BY s.fetched_at DESC,s.id LIMIT 100`,
      [pickId, ownerId, triggerObservedAt, now],
    )
  ).rows;
  return rows.flatMap((r) => {
    const values = z
      .array(observedDecisionQuoteSchema)
      .max(30)
      .safeParse(r.raw?.decisionQuotes);
    return values.success
      ? values.data.filter(
          (q) =>
            q.marketId === r.native_id &&
            q.outcomeId === r.outcome &&
            q.rulesHash === r.rules_hash,
        )
      : [];
  });
}
