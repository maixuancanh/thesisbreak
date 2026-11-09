import { z } from "zod";
import { createHash } from "node:crypto";
export type ScheduleSnapshot = {
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
  body: string;
};
const team = z.object({ id: z.string(), abbreviation: z.string() });
const competitor = z.object({
  homeAway: z.enum(["home", "away"]),
  team,
  score: z.string().optional(),
});
const event = z.object({
  id: z.string(),
  date: z.preprocess(
    (v) =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(v)
        ? v.replace("Z", ":00Z")
        : v,
    z.iso.datetime({ offset: true }),
  ),
  competitions: z
    .array(
      z.object({
        competitors: z.array(competitor),
        status: z.object({
          type: z.object({ completed: z.boolean(), state: z.string() }),
        }),
      }),
    )
    .min(1),
});
export function parseEspnSchedule(raw: unknown, retrievedAt: string) {
  z.iso.datetime({ offset: true }).parse(retrievedAt);
  const data = z.object({ events: z.array(event).max(100) }).parse(raw);
  return data.events.map((e) => {
    const c = e.competitions[0]!,
      home = c.competitors.find((t) => t.homeAway === "home"),
      away = c.competitors.find((t) => t.homeAway === "away");
    if (!home || !away || home.team.id === away.team.id)
      throw Error("INVALID_EVENT_TEAMS");
    return {
      eventId: `espn:${e.id}`,
      scheduledAt: e.date,
      homeTeam:
        (
          {
            GS: "GSW",
            NY: "NYK",
            NO: "NOP",
            SA: "SAS",
            UTAH: "UTA",
            WSH: "WAS",
          } as Record<string, string>
        )[home.team.abbreviation] ?? home.team.abbreviation,
      awayTeam:
        (
          {
            GS: "GSW",
            NY: "NYK",
            NO: "NOP",
            SA: "SAS",
            UTAH: "UTA",
            WSH: "WAS",
          } as Record<string, string>
        )[away.team.abbreviation] ?? away.team.abbreviation,
      status: c.status.type.completed
        ? ("final" as const)
        : ("pending" as const),
      homeScore: home.score === undefined ? null : Number(home.score),
      awayScore: away.score === undefined ? null : Number(away.score),
      retrievedAt,
      sourceUrl: `https://www.espn.com/nba/game/_/gameId/${e.id}`,
      provider: "espn_public" as const,
      officialNba: false as const,
      lineupConfirmed: false as const,
    };
  });
}
export async function readEspnSchedule(
  date: string,
  transport: typeof fetch = fetch,
  onSnapshot?: (snapshot: ScheduleSnapshot) => Promise<void>,
): Promise<
  (ReturnType<typeof parseEspnSchedule>[number] & {
    provenance?: Omit<ScheduleSnapshot, "body">;
  })[]
> {
  if (!/^\d{8}$/.test(date)) throw Error("INVALID_DATE");
  const sourceUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}&limit=100`;
  const response = await transport(sourceUrl, {
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error("ESPN_SCHEDULE_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 2000000) throw Error("SCHEDULE_TOO_LARGE");
  const retrievedAt = new Date().toISOString();
  const parsed = parseEspnSchedule(JSON.parse(text), retrievedAt);
  const provenance = {
    sourceUrl,
    retrievedAt,
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
  await onSnapshot?.({ ...provenance, body: text });
  return parsed.map((event) => ({ ...event, provenance }));
}
