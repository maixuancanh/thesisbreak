import { readEspnOdds } from "./news/espn-odds";
import {
  readForecastBookmakers,
  matchedBookmakerBaseline,
} from "./forecast-bookmaker";
import type { Pool } from "pg";
import { prepareNbaForecast } from "./forecast-pipeline";
import {
  loadObservedHistory,
  persistNbaObservation,
} from "./forecast-observations";
import { historyForElo, restBeforeGame } from "./news/nba-history";
import { fetchOfficialNbaGameForMatch } from "./news/nba-game";
import { captureNbaForecast } from "../../db/src/forecast-ledger";
import { readEspnSchedule, type ScheduleSnapshot } from "./news/espn-schedule";
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
export async function captureDueForecasts(
  pool: Pool,
  read = readEspnSchedule,
  options: { maximumEvents?: number } = {},
) {
  const maximumEvents = options.maximumEvents ?? 20;
  if (
    !Number.isInteger(maximumEvents) ||
    maximumEvents < 1 ||
    maximumEvents > 20
  )
    throw Error("INVALID_CAPTURE_BATCH");
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
  const snapshots: ScheduleSnapshot[] = [];
  const events = (
    await Promise.all(
      dates.map((d) =>
        read(d, fetch, async (snapshot) => {
          snapshots.push(snapshot);
        }),
      ),
    )
  ).flat();
  let captured = 0,
    waiting = 0;
  const history = await loadObservedHistory(pool, new Date());
  const capturedKeys = new Set(
    (
      await pool.query(
        "SELECT user_id,event_id,horizon FROM nba_forecasts WHERE namespace='live' AND method_version='nba-elo-prospective-v2' AND scheduled_at>$1",
        [now],
      )
    ).rows.map((r) => `${r.user_id}:${r.event_id}:${r.horizon}`),
  );
  const needsCapture = (e: (typeof events)[number], h: string) =>
    subscribers.some(
      (u) => !capturedKeys.has(`${u.user_id}:${e.eventId}:${h}`),
    );
  const hasDue = events.some(
    (e) =>
      e.status === "pending" &&
      dueForecastHorizons(e.scheduledAt, now).some((h) => needsCapture(e, h)),
  );
  if (!hasDue)
    return { subscribers: subscribers.length, captured: 0, waiting: 0 };
  // Keep exact source evidence for capture attempts without storing identical idle polls every minute.
  for (const snapshot of snapshots)
    await persistNbaObservation(
      pool,
      snapshot.sourceUrl,
      snapshot.retrievedAt,
      {
        ...JSON.parse(snapshot.body),
        _originalResponse: snapshot.body,
        _originalSha256: snapshot.contentHash,
      },
    );
  const bookmakers = await readForecastBookmakers(pool);
  let processedEvents = 0;
  for (const event of events) {
    if (event.status !== "pending") continue;
    const horizons = dueForecastHorizons(event.scheduledAt, now).filter((h) =>
      needsCapture(event, h),
    );
    if (!horizons.length) continue;
    if (processedEvents++ >= maximumEvents) break;
    const easternDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(event.scheduledAt));
    const official = await fetchOfficialNbaGameForMatch({
      eventDate: easternDate,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
    });
    if (official.provenance)
      await persistNbaObservation(
        pool,
        official.provenance.sourceUrl,
        official.provenance.retrievedAt,
        official,
      );
    const asOf = (await pool.query("SELECT clock_timestamp() AS t")).rows[0]
      .t as Date;
    let publicBookmaker: Awaited<ReturnType<typeof readEspnOdds>> = null;
    try {
      publicBookmaker = await readEspnOdds(event);
      if (publicBookmaker)
        await persistNbaObservation(
          pool,
          publicBookmaker.sourceUrl,
          publicBookmaker.retrievedAt,
          publicBookmaker,
        );
    } catch {
      /* Missing quote stays explicitly unavailable. */
    }
    const baseline = matchedBookmakerBaseline(
      bookmakers.events,
      {
        ...event,
        ...(official.game &&
        Date.parse(official.game.scheduledAt) === Date.parse(event.scheduledAt)
          ? { officialGameId: official.game.gameId }
          : {}),
      },
      asOf,
    );
    const historical = historyForElo(history, asOf.toISOString());
    const rest = restBeforeGame(
      history,
      event.homeTeam,
      event.awayTeam,
      event.scheduledAt,
    );
    const teamSamples = (team: string) =>
      historical.games.filter((g) => g.homeTeam === team || g.awayTeam === team)
        .length;
    const enough =
      !!rest &&
      teamSamples(event.homeTeam) >= 3 &&
      teamSamples(event.awayTeam) >= 3;
    const prepared = enough
      ? prepareNbaForecast({
          asOf: asOf.toISOString(),
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          homeRestDays: rest!.homeRestDays,
          awayRestDays: rest!.awayRestDays,
          games: historical.games,
          config: {},
          requiresLineup: false,
          lineupConfirmed: official.game?.lineupConfirmed ?? false,
          staleEvidence: false,
          conflictingEvidence: false,
          evidenceRefs: [event.sourceUrl],
        })
      : null;
    for (const horizon of horizons)
      for (const user of subscribers) {
        const exists = (
          await pool.query(
            "SELECT id FROM nba_forecasts WHERE user_id=$1 AND namespace='live' AND event_id=$2 AND horizon=$3 AND method_version='nba-elo-prospective-v2'",
            [user.user_id, event.eventId, horizon],
          )
        ).rows.length;
        if (exists) continue;
        await captureNbaForecast(pool, user.user_id, {
          namespace: "live",
          eventId: event.eventId,
          league: "NBA",
          horizon,
          methodVersion: "nba-elo-prospective-v2",
          modelVersion: "elo-statistical-v1",
          modelConfig: {
            scheduleProvider: event.provider,
            officialNba: false,
            evidenceSemantics:
              "observed schedule snapshot, not original publication",
            requiresConfirmedLineup: false,
            lineupConfirmed: official.game?.lineupConfirmed ?? false,
            lineupAdjustment:
              "none: base Elo does not model player availability",
            trainingEventIds: prepared?.trainingEventIds ?? [],
            homeRestDays: rest?.homeRestDays ?? null,
            awayRestDays: rest?.awayRestDays ?? null,
            bookmakerCoverage: bookmakers.state,
            bookmakerBaseline: baseline,
            publicBookmakerSnapshot: publicBookmaker,
            parameters: { homeAdvantage: 65, k: 20, restPointsPerDay: 0 },
          },
          scheduledAt: event.scheduledAt,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          probability: prepared?.probability ?? null,
          baselineProbability: baseline?.probability ?? null,
          abstentionReason:
            prepared?.probability !== null &&
            prepared?.probability !== undefined
              ? null
              : "Insufficient observed historical games or prior rest history; no probability issued.",
          evidence: [
            {
              url: event.provenance?.sourceUrl ?? event.sourceUrl,
              publishedAt: null,
              retrievedAt: event.retrievedAt,
              ...(event.provenance
                ? { contentHash: event.provenance.contentHash }
                : {}),
            },
          ],
          memoryConsent: user.memory_consent,
        });
        captured++;
        if (!prepared || prepared.probability === null) waiting++;
      }
  }
  return { subscribers: subscribers.length, captured, waiting };
}
