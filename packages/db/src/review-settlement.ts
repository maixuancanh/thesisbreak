import { settlementSchema } from "../../domain/src/reason-review";
import type { ContextInput } from "../../agent/src/context";
type Database = {
  query: (
    sql: string,
    values: unknown[],
  ) => Promise<{ rows: { created_at: Date | string }[] }>;
};
/** Resolution must originate in the verified public adapter, never a browser/model field. */
export async function readReviewSettlement(
  db: Database,
  pick: ContextInput["pick"],
  source: {
    provider: string;
    resolution?: { outcome: string; resolvedAt: string } | null;
  },
) {
  if (
    !pick ||
    pick.market.platform !== "kalshi" ||
    source.provider !== "kalshi-public" ||
    !source.resolution
  )
    return null;
  const record = (
    await db.query(
      "SELECT v.created_at FROM picks p JOIN pick_versions v ON v.pick_id=p.id AND v.user_id=p.user_id AND v.version=p.current_version WHERE p.id=$1 AND p.user_id=$2 AND p.current_version=$3 AND p.platform=$4 AND p.native_id=$5",
      [
        pick.pickId,
        pick.userId,
        pick.version,
        pick.market.platform,
        pick.market.nativeId,
      ],
    )
  ).rows[0];
  return record
    ? settlementSchema.parse({
        ...source.resolution,
        pickRecordedAt: new Date(record.created_at).toISOString(),
        sourceRef: "final-settlement",
      })
    : null;
}
