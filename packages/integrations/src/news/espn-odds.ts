import { z } from "zod";
import { createHash } from "node:crypto";
import { devigDecimalOdds } from "../../../domain/src/forecast-model";
const timestamp = z.string().transform((s, ctx) => {
  const n = Date.parse(s);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: "INVALID_TIME" });
    return z.NEVER;
  }
  return new Date(n).toISOString();
});
const schema = z.object({
  header: z.object({
    id: z.string(),
    competitions: z
      .array(
        z.object({
          date: timestamp,
          competitors: z
            .array(
              z.object({
                homeAway: z.enum(["home", "away"]),
                id: z.string(),
                team: z.object({ abbreviation: z.string() }),
              }),
            )
            .length(2),
        }),
      )
      .length(1),
  }),
  pickcenter: z
    .array(
      z.object({
        provider: z.object({ id: z.string(), name: z.string() }),
        homeTeamOdds: z.object({
          teamId: z.string(),
          moneyLine: z.number().int(),
        }),
        awayTeamOdds: z.object({
          teamId: z.string(),
          moneyLine: z.number().int(),
        }),
      }),
    )
    .optional(),
});
const aliases: Record<string, string> = {
  GS: "GSW",
  NY: "NYK",
  NO: "NOP",
  SA: "SAS",
  UTAH: "UTA",
  WSH: "WAS",
};
const code = (s: string) => aliases[s] ?? s;
const decimal = (x: number) => {
  if (Math.abs(x) < 100) throw Error("INVALID_AMERICAN_ODDS");
  return x > 0 ? 1 + x / 100 : 1 + 100 / Math.abs(x);
};
export function parseEspnOdds(
  raw: unknown,
  target: {
    eventId: string;
    scheduledAt: string;
    homeTeam: string;
    awayTeam: string;
  },
  retrievedAt: string,
) {
  const x = schema.parse(raw),
    id = target.eventId.replace(/^espn:/, "");
  if (x.header.id !== id) throw Error("ODDS_EVENT_MISMATCH");
  const c = x.header.competitions[0]!,
    h = c.competitors.find((c) => c.homeAway === "home")!,
    a = c.competitors.find((c) => c.homeAway === "away")!;
  if (
    code(h.team.abbreviation) !== target.homeTeam ||
    code(a.team.abbreviation) !== target.awayTeam ||
    Date.parse(c.date) !== Date.parse(target.scheduledAt)
  )
    throw Error("ODDS_IDENTITY_MISMATCH");
  if (Date.parse(retrievedAt) >= Date.parse(target.scheduledAt))
    throw Error("EVENT_STARTED");
  const quotes = (x.pickcenter ?? [])
    .filter(
      (q) => q.homeTeamOdds.teamId === h.id && q.awayTeamOdds.teamId === a.id,
    )
    .sort((a, b) => a.provider.id.localeCompare(b.provider.id));
  if (!quotes[0]) return null;
  const q = quotes[0];
  return {
    probability: devigDecimalOdds(
      decimal(q.homeTeamOdds.moneyLine),
      decimal(q.awayTeamOdds.moneyLine),
    ).homeProbability,
    bookmaker: q.provider.name,
    provider: "espn_published_bookmaker_quote",
    sourceUrl: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`,
    retrievedAt,
    sourceUpdatedAt: null,
    freshness: "observed_now_update_time_unavailable",
    timestampMatched: false,
    homeMoneyLine: q.homeTeamOdds.moneyLine,
    awayMoneyLine: q.awayTeamOdds.moneyLine,
    selection: "first alphabetical provider id v1",
    contentHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  };
}
export async function readEspnOdds(
  target: Parameters<typeof parseEspnOdds>[1],
  transport: typeof fetch = fetch,
) {
  if (!/^espn:\d+$/.test(target.eventId)) throw Error("INVALID_EVENT");
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${target.eventId.slice(5)}`;
  const response = await transport(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error("PUBLIC_ODDS_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 3000000) throw Error("PUBLIC_ODDS_TOO_LARGE");
  return parseEspnOdds(JSON.parse(text), target, new Date().toISOString());
}
