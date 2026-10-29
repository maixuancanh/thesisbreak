import type { Pool } from "pg";
import { BookmakerAdapter } from "./bookmaker";
import { reserveProviderCredits } from "../../db/src/provider-budget";
import { persistNbaObservation } from "./forecast-observations";
const names: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};
export async function readForecastBookmakers(pool: Pool, env = process.env) {
  const key = env.BOOKMAKER_API_KEY;
  if (!key) return { state: "unconfigured" as const, events: [] };
  try {
    const adapter = new BookmakerAdapter(key, (c) =>
      reserveProviderCredits(
        pool,
        "bookmaker_forecasts",
        c,
        Number(env.BOOKMAKER_DAILY_CREDIT_LIMIT ?? 20),
      ),
    );
    const result = await adapter.nba();
    await persistNbaObservation(
      pool,
      "https://api.the-odds-api.com/v4/sports/basketball_nba/odds",
      new Date().toISOString(),
      result,
    );
    return { state: "available" as const, events: result.events };
  } catch {
    return { state: "unavailable" as const, events: [] };
  }
}
export function matchedBookmakerBaseline(
  events: Awaited<ReturnType<typeof readForecastBookmakers>>["events"],
  target: { homeTeam: string; awayTeam: string; scheduledAt: string },
  now: Date,
) {
  const matches = events.filter(
    (e) =>
      e.home === names[target.homeTeam] &&
      e.away === names[target.awayTeam] &&
      Date.parse(e.scheduledAt) === Date.parse(target.scheduledAt),
  );
  if (matches.length !== 1) return null;
  const e = matches[0]!,
    quotes = e.quotes
      .filter(
        (q) =>
          Date.parse(q.asOf) <= now.getTime() &&
          now.getTime() - Date.parse(q.asOf) <= 300000,
      )
      .sort((a, b) => a.bookmaker.localeCompare(b.bookmaker));
  const selected = quotes[0];
  if (!selected) return null;
  return {
    probability: selected.outcomes.find((o) => o.name === e.home)!.probability,
    bookmaker: selected.bookmaker,
    asOf: selected.asOf,
    eventId: e.eventId,
    method: e.probabilityMethod,
    selection: "first alphabetical eligible bookmaker, preregistered v1",
    settlementRulesVerified: false,
  };
}
