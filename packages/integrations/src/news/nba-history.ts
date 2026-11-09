import { createHash } from "node:crypto";
import { z } from "zod";
import type { EloGame } from "../../../domain/src/forecast-model";

const DAY = 86400000;
const timestamp = z.string().transform((s, ctx) => {
  const ms = Date.parse(s);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(ms)) {
    ctx.addIssue({ code: "custom", message: "INVALID_TIMESTAMP" });
    return z.NEVER;
  }
  return new Date(ms).toISOString();
});
const aliases: Record<string, string> = {
  GS: "GSW",
  NY: "NYK",
  NO: "NOP",
  SA: "SAS",
  UTAH: "UTA",
  WSH: "WAS",
};
const canonicalTeams = new Set(
  "ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS".split(
    " ",
  ),
);
const teamCode = z
  .string()
  .transform((code) => aliases[code] ?? code)
  .refine((code) => canonicalTeams.has(code), "UNKNOWN_NBA_TEAM");
const competitor = z.object({
  homeAway: z.enum(["home", "away"]),
  team: z.object({ id: z.string().min(1), abbreviation: teamCode }),
  score: z.string().optional(),
});
const feed = z.object({
  events: z
    .array(
      z.object({
        id: z.string().regex(/^\d+$/),
        date: timestamp,
        competitions: z
          .array(
            z.object({
              id: z.string().optional(),
              neutralSite: z.boolean().optional(),
              competitors: z.array(competitor).length(2),
              status: z.object({
                type: z.object({
                  completed: z.boolean(),
                  state: z.string(),
                  name: z.string().optional(),
                }),
              }),
            }),
          )
          .length(1),
      }),
    )
    .max(100),
});
export interface HistorySnapshot {
  sourceUrl: string;
  retrievedAt: string;
  sha256: string;
  body: string;
}
export interface NbaHistoryRecord {
  eventId: string;
  scheduledAt: string;
  homeTeam: string;
  awayTeam: string;
  status: "final" | "pending" | "void";
  homeScore: number | null;
  awayScore: number | null;
  neutral: boolean;
  /** Conservative availability timestamp. This is NOT the actual game end time. */
  resolvedAt: string | null;
  finalObservedAt: string | null;
  resultPublishedAt: null;
  retrievedAt: string;
  sourceUrl: string;
  snapshotSha256: string;
  provider: "espn_public";
  publisher: "ESPN";
  officialNba: false;
}
/** ESPN is the publisher of this public fallback; it is not an official NBA feed.
 * A historical result fetched today only becomes available today, never retroactively.
 */
export function parseEspnHistory(
  raw: unknown,
  provenance: Omit<HistorySnapshot, "body">,
): NbaHistoryRecord[] {
  const retrievedAt = z.iso
    .datetime({ offset: true })
    .parse(provenance.retrievedAt);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(provenance.sha256);
  const seen = new Set<string>();
  return feed.parse(raw).events.map((event) => {
    const eventId = `espn:${event.id}`;
    if (seen.has(eventId)) throw Error("DUPLICATE_EVENT");
    seen.add(eventId);
    const competition = event.competitions[0]!;
    if (competition.id && competition.id !== event.id)
      throw Error("MISMATCHED_EVENT_ID");
    const home = competition.competitors.find((c) => c.homeAway === "home"),
      away = competition.competitors.find((c) => c.homeAway === "away");
    if (
      !home ||
      !away ||
      home.team.id === away.team.id ||
      home.team.abbreviation === away.team.abbreviation
    )
      throw Error("INVALID_TEAMS");
    const type = competition.status.type;
    const voided = /CANCEL|POSTPON|SUSPEND/.test(type.name ?? "");
    const final = type.completed && type.state === "post" && !voided;
    const score = (s: string | undefined) =>
      s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN;
    const h = score(home.score),
      a = score(away.score);
    if (
      final &&
      (!Number.isSafeInteger(h) ||
        !Number.isSafeInteger(a) ||
        h === a ||
        Date.parse(event.date) >= Date.parse(retrievedAt))
    )
      throw Error("INVALID_FINAL");
    return {
      eventId,
      scheduledAt: event.date,
      homeTeam: home.team.abbreviation,
      awayTeam: away.team.abbreviation,
      status: voided ? "void" : final ? "final" : "pending",
      homeScore: final ? h : null,
      awayScore: final ? a : null,
      neutral: competition.neutralSite ?? false,
      resolvedAt: final ? retrievedAt : null,
      finalObservedAt: final ? retrievedAt : null,
      resultPublishedAt: null,
      retrievedAt,
      sourceUrl: provenance.sourceUrl,
      snapshotSha256: provenance.sha256,
      provider: "espn_public",
      publisher: "ESPN",
      officialNba: false,
    };
  });
}
function dateValue(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("INVALID_DATE");
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw Error("INVALID_DATE");
  return ms;
}
/** At most 62 past UTC dates, sequential bounded requests; failure never returns a partial dataset. */
export async function fetchNbaHistory(options: {
  startDate: string;
  endDate: string;
  now?: Date;
  transport?: typeof fetch;
  onSnapshot?: (snapshot: HistorySnapshot) => Promise<void>;
}) {
  const start = dateValue(options.startDate),
    end = dateValue(options.endDate);
  if (end < start || (end - start) / DAY >= 62) throw Error("DATE_RANGE");
  const clock = options.now ?? new Date();
  if (end > dateValue(clock.toISOString().slice(0, 10)))
    throw Error("FUTURE_DATE");
  const records: NbaHistoryRecord[] = [],
    snapshots: Omit<HistorySnapshot, "body">[] = [];
  const seen = new Set<string>();
  for (let date = start; date <= end; date += DAY) {
    const key = new Date(date).toISOString().slice(0, 10).replaceAll("-", "");
    const sourceUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${key}&limit=100`;
    const response = await (options.transport ?? fetch)(sourceUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok || !response.body) throw Error("HISTORY_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2_000_000) throw Error("HISTORY_TOO_LARGE");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const snapshot = {
      sourceUrl,
      retrievedAt: (options.now ?? new Date()).toISOString(),
      sha256: createHash("sha256").update(body).digest("hex"),
      body,
    };
    const parsed = parseEspnHistory(JSON.parse(body), snapshot);
    for (const record of parsed) {
      if (seen.has(record.eventId)) throw Error("DUPLICATE_EVENT");
      seen.add(record.eventId);
      records.push(record);
    }
    await options.onSnapshot?.(snapshot);
    snapshots.push({
      sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      sha256: snapshot.sha256,
    });
  }
  records.sort(
    (a, b) =>
      Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) ||
      a.eventId.localeCompare(b.eventId),
  );
  return {
    records,
    snapshots,
    provider: "espn_public" as const,
    officialNba: false as const,
    retrospectiveForecasts: false as const,
  };
}
/** Full rest days from the previous played game's start: back-to-back = zero.
 * Missing prior starts return null. A truncated archive never implies guessed rest.
 * Callers must provide complete date coverage between the previous and target starts.
 */
export function restBeforeGame(
  records: NbaHistoryRecord[],
  homeTeam: string,
  awayTeam: string,
  scheduledAt: string,
) {
  const target = Date.parse(timestamp.parse(scheduledAt));
  const previous = (team: string) =>
    records
      .filter(
        (g) =>
          g.status === "final" &&
          Date.parse(g.scheduledAt) < target &&
          (g.homeTeam === team || g.awayTeam === team),
      )
      .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))[0]
      ?.scheduledAt;
  const homePreviousStart = previous(homeTeam),
    awayPreviousStart = previous(awayTeam);
  if (!homePreviousStart || !awayPreviousStart) return null;
  const days = (start: string) =>
    Math.max(0, Math.floor((target - Date.parse(start)) / DAY) - 1);
  return {
    homeRestDays: days(homePreviousStart),
    awayRestDays: days(awayPreviousStart),
    homePreviousStart,
    awayPreviousStart,
  };
}
/** Scheduler adapter. Fresh backfills cannot seed a forecast with an earlier asOf.
 * Exclusions remain visible; this does not create historical forecasts or labels.
 */
export function historyForElo(records: NbaHistoryRecord[], asOf: string) {
  const cutoff = Date.parse(timestamp.parse(asOf));
  const games: EloGame[] = [],
    excluded: { eventId: string; reason: string }[] = [];
  const available = records.filter(
    (r) =>
      r.status === "final" &&
      r.finalObservedAt &&
      Date.parse(r.finalObservedAt) < cutoff &&
      Date.parse(r.scheduledAt) < cutoff,
  );
  for (const record of records) {
    if (!available.includes(record)) {
      excluded.push({
        eventId: record.eventId,
        reason: "result_not_available_before_asof",
      });
      continue;
    }
    const rest = restBeforeGame(
      available,
      record.homeTeam,
      record.awayTeam,
      record.scheduledAt,
    );
    if (!rest) {
      excluded.push({ eventId: record.eventId, reason: "missing_prior_start" });
      continue;
    }
    games.push({
      eventId: record.eventId,
      homeTeam: record.homeTeam,
      awayTeam: record.awayTeam,
      scheduledAt: record.scheduledAt,
      resolvedAt: record.finalObservedAt,
      status: "final",
      homeScore: record.homeScore,
      awayScore: record.awayScore,
      homeRestDays: rest.homeRestDays,
      awayRestDays: rest.awayRestDays,
      neutral: record.neutral,
    });
  }
  games.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  return { games, excluded, asOf };
}
