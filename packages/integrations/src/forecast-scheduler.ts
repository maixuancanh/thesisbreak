import type { Pool } from "pg";
import { captureNbaForecast } from "../../db/src/forecast-ledger";
import { readEspnSchedule } from "./news/espn-schedule";
export function dueForecastHorizons(scheduledAt: string, now: Date) {
  const diff = Date.parse(scheduledAt) - now.getTime();
  if (!Number.isFinite(diff)) throw Error("INVALID_START");
  return (["T24h", "T60m"] as const).filter(
    (h) =>
      Math.abs(diff - (h === "T24h" ? 86400000 : 3600000)) <= 5 * 60000 &&
      diff > 0,
  );
}
/** Observed schedule snapshots are not publication timestamps or confirmed player lineups. */
export async function captureDueForecasts(pool: Pool, read = readEspnSchedule) {
  const now = (await pool.query("SELECT clock_timestamp() AS t")).rows[0]
    .t as Date;
  const dates = [0, 1, 2].map((d) =>
    new Date(now.getTime() + d * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", ""),
  );
  const subscribers = (
    await pool.query(
      "SELECT user_id,memory_consent FROM nba_forecast_subscriptions WHERE enabled=true ORDER BY user_id LIMIT 100",
    )
  ).rows;
  if (!subscribers.length) return { subscribers: 0, captured: 0, waiting: 0 };
  const events = (await Promise.all(dates.map((d) => read(d)))).flat();
  let captured = 0;
  for (const event of events) {
    if (event.status !== "pending") continue;
    for (const horizon of dueForecastHorizons(event.scheduledAt, now))
      for (const user of subscribers) {
        const exists = (
          await pool.query(
            "SELECT id FROM nba_forecasts WHERE user_id=$1 AND namespace='live' AND event_id=$2 AND horizon=$3 AND method_version='nba-availability-gated-v1'",
            [user.user_id, event.eventId, horizon],
          )
        ).rows.length;
        if (exists) continue;
        await captureNbaForecast(pool, user.user_id, {
          namespace: "live",
          eventId: event.eventId,
          league: "NBA",
          horizon,
          methodVersion: "nba-availability-gated-v1",
          modelVersion: "deterministic-prerequisite-policy-v1",
          modelConfig: {
            scheduleProvider: event.provider,
            officialNba: false,
            evidenceSemantics:
              "observed schedule snapshot, not original publication",
            requiresConfirmedLineup: true,
          },
          scheduledAt: event.scheduledAt,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          probability: null,
          baselineProbability: null,
          abstentionReason:
            "Confirmed official lineup and validated model inputs unavailable; no probability issued.",
          evidence: [
            {
              url: event.sourceUrl,
              publishedAt: event.retrievedAt,
              retrievedAt: event.retrievedAt,
            },
          ],
          memoryConsent: user.memory_consent,
        });
        captured++;
      }
  }
  return { subscribers: subscribers.length, captured, waiting: captured };
}
