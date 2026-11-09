import { z } from "zod";
import { forecastEligibility } from "../../domain/src/forecast";
import { DomainConflict } from "../../domain/src/proposal";

export function storedEventStart(raw: unknown): string | null {
  const row = z
    .object({
      scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
    })
    .safeParse(raw);
  return row.success ? (row.data.scheduledAt ?? null) : null;
}
export function assertEventNotStarted(raw: unknown, now = new Date()) {
  if (
    forecastEligibility(now.toISOString(), storedEventStart(raw)) ===
    "event_started"
  )
    throw new DomainConflict("EVENT_ALREADY_STARTED");
}
/** Read frozen metadata under the caller's pick lock, with database wall-clock time. */
export async function assertStoredPickNotStarted(
  client: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  userId: string,
  pickId: string,
  version: number,
) {
  const row = (
    await client.query(
      "SELECT s.raw,clock_timestamp() AS checked_at FROM pick_versions v LEFT JOIN market_snapshots s ON s.id=v.snapshot_id WHERE v.pick_id=$1 AND v.user_id=$2 AND v.version=$3",
      [pickId, userId, version],
    )
  ).rows[0];
  if (!row) throw new Error("MISSING_BASE_VERSION");
  assertEventNotStarted(row.raw, new Date(row.checked_at as string | Date));
}
