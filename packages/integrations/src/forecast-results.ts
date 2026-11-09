import type { Pool } from "pg";
import { fetchOfficialNbaGameForMatch } from "./news/nba-game";
import { persistNbaObservation } from "./forecast-observations";
import { recordNbaOfficialResult } from "../../db/src/forecast-ledger";
const easternDate = (s: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(s));
/** NBA final state, observed now; never invent the precise finalization time. */
export async function refreshNbaForecastResults(
  pool: Pool,
  read = fetchOfficialNbaGameForMatch,
  maximumTargets = 12,
) {
  if (
    !Number.isInteger(maximumTargets) ||
    maximumTargets < 1 ||
    maximumTargets > 12
  )
    throw Error("INVALID_RESULT_BATCH");
  const targets = (
    await pool.query(
      "SELECT DISTINCT f.event_id,f.payload->>'homeTeam' AS home,f.payload->>'awayTeam' AS away,f.scheduled_at,COALESCE(h.last_started_at,'epoch'::timestamptz) AS checked_at FROM nba_forecasts f LEFT JOIN forecast_worker_health h ON h.job='nba.result:'||f.event_id WHERE namespace='live' AND scheduled_at<now()-interval '2 hours' AND scheduled_at>now()-interval '14 days' ORDER BY checked_at,scheduled_at ASC LIMIT $1",
      [maximumTargets],
    )
  ).rows;
  let verified = 0,
    updated = 0,
    unavailable = 0;
  for (const target of targets) {
    await pool.query(
      "INSERT INTO forecast_worker_health(job,last_started_at) VALUES($1,clock_timestamp()) ON CONFLICT(job) DO UPDATE SET last_started_at=clock_timestamp()",
      [`nba.result:${target.event_id}`],
    );
    const scheduledAt = new Date(target.scheduled_at).toISOString();
    const found = await read({
      eventDate: easternDate(scheduledAt),
      homeTeam: target.home,
      awayTeam: target.away,
    });
    if (found.state !== "available" || !found.game || !found.provenance) {
      unavailable++;
      continue;
    }
    if (Date.parse(found.game.scheduledAt) !== Date.parse(scheduledAt)) {
      unavailable++;
      continue;
    }
    const provenance = found.provenance;
    await persistNbaObservation(
      pool,
      provenance.sourceUrl,
      provenance.retrievedAt,
      found,
    );
    verified++;
    const status =
      found.game.status === "final" ? ("final" as const) : ("pending" as const);
    const winner =
      status === "final"
        ? found.game.homeScore > found.game.awayScore
          ? target.home
          : target.away
        : null;
    const owners = (
      await pool.query(
        "SELECT DISTINCT user_id FROM nba_forecasts WHERE namespace='live' AND event_id=$1",
        [target.event_id],
      )
    ).rows;
    for (const owner of owners) {
      const previous = (
        await pool.query(
          "SELECT payload FROM nba_forecast_results WHERE user_id=$1 AND namespace='live' AND event_id=$2 ORDER BY revision DESC LIMIT 1",
          [owner.user_id, target.event_id],
        )
      ).rows[0]?.payload;
      if (previous?.status === status && previous?.winner === winner) continue;
      await recordNbaOfficialResult(pool, owner.user_id, {
        namespace: "live",
        eventId: target.event_id,
        revision: (previous?.revision ?? 0) + 1,
        scheduledAt,
        resolvedAt: status === "final" ? provenance.retrievedAt : null,
        status,
        winner,
        verifiedOfficial: true,
        sourceUrl: provenance.sourceUrl,
        retrievedAt: provenance.retrievedAt,
      });
      updated++;
    }
  }
  return { checked: targets.length, verified, updated, unavailable };
}
