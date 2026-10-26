import { z } from "zod";
import { fetchNbaReport } from "./nba";
import { fetchBallDontLie } from "./balldontlie";
import { fetchFedReleases, fetchTeamAnnouncements } from "./feeds";
import { nbaTarget, selectEvidence } from "./mapping";
export const newsItemSchema = z.object({
  id: z.string().min(1).max(256),
  url: z.url(),
  title: z.string().max(1000),
  text: z.string().max(10000),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  retrievedAt: z.iso.datetime({ offset: true }),
  eventDate: z.string().nullable(),
  teams: z.array(z.string()).max(2),
  player: z.string().optional(),
  status: z.string().optional(),
});
export const newsCheckSchema = z.object({
  source: z.string().max(80),
  state: z.enum([
    "available",
    "unavailable",
    "invalid",
    "unconfigured",
    "access_required",
    "rate_limited",
    "partial",
    "unmapped",
  ]),
  items: z.array(newsItemSchema).max(100),
  background: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type NewsCheck = z.infer<typeof newsCheckSchema>;
const cache = new Map<string, { expires: number; promise: Promise<unknown> }>();
async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now())
    return existing.promise as Promise<T>;
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  const promise = read();
  cache.set(key, { expires: Date.now() + 300000, promise });
  try {
    return await promise;
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}
/** Only trusted market identity enters here. Public facts are cached independently of account data. */
export async function collectIndependent(m: {
  platform: string;
  nativeId: string;
  eventId?: string | null;
}): Promise<NewsCheck[]> {
  const now = new Date().toISOString(),
    target = nbaTarget(m);
  const wrap = async (
    source: string,
    background: boolean,
    read: () => Promise<{ state: string; items: unknown[] }>,
  ): Promise<NewsCheck> => {
    try {
      const result = await read();
      return newsCheckSchema.parse({
        ...result,
        source,
        background,
        items: result.items.slice(0, 100),
        checkedAt: now,
      });
    } catch {
      return {
        source,
        background,
        state: "unavailable",
        items: [],
        checkedAt: now,
      };
    }
  };
  if (!target)
    return [
      await wrap("fed-official", true, () => cached("fed", fetchFedReleases)),
      {
        source: "nba-event-mapping",
        state: "unmapped",
        background: false,
        items: [],
        checkedAt: now,
      },
    ];
  const feature =
    process.env.BALLDONTLIE_FEATURES === "lineups"
      ? "lineups"
      : process.env.BALLDONTLIE_FEATURES === "injuries"
        ? "injuries"
        : "games";
  return Promise.all([
    wrap("nba-official", false, async () => {
      const r = await cached("nba-report", fetchNbaReport);
      return { ...r, items: selectEvidence(r.items, target) };
    }),
    wrap("balldontlie", feature === "injuries", async () => {
      const r = await cached(
        `bdl:${target.eventDate}:${target.teams.join(":")}:${feature}`,
        () => fetchBallDontLie(target, { features: feature }),
      );
      return { ...r, items: r.items };
    }),
    ...(target.slugs ?? []).map((slug) =>
      wrap(`team-official:${slug}`, true, () =>
        cached(`team:${slug}`, () => fetchTeamAnnouncements(slug)),
      ),
    ),
  ]);
}
export function independentAgentSources(checks: NewsCheck[], query = "") {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const relevant = (player: string | undefined) => {
    if (!player) return 0;
    const p = player.split(",").map((s) => s.trim());
    const name = norm(p.length === 2 ? `${p[1]} ${p[0]}` : player);
    return name.includes(" ") && ` ${norm(query)} `.includes(` ${name} `)
      ? 1
      : 0;
  };
  const sourceStatus = {
    id: "independent-status",
    url: "",
    retrievedAt: new Date().toISOString(),
    text: JSON.stringify({
      note: "Coverage status, not evidence of absence. Background announcements are not mapped to this game's lineup.",
      sources: checks.map(({ source, state, background, checkedAt }) => ({
        source,
        state,
        background,
        checkedAt,
      })),
    }),
  };
  const items = checks
    .filter((c) => c.state === "available" || c.state === "partial")
    .flatMap((c) =>
      [...c.items]
        .sort((a, b) => relevant(b.player) - relevant(a.player))
        .slice(0, c.background ? 2 : 6)
        .map((i) => ({
          kind: (c.state === "available" &&
          !c.background &&
          (c.source === "nba-official" ||
            (c.source === "balldontlie" && !!i.eventDate && !!i.player))
            ? "official_event"
            : "background") as "official_event" | "background",
          id: `news:${c.source}:${i.id}`.slice(0, 256),
          url: i.url,
          retrievedAt: i.retrievedAt,
          publishedAt: i.publishedAt,
          text: JSON.stringify({
            source: c.source,
            state: c.state,
            background: c.background,
            ...i,
            text: i.text.slice(0, 600),
          }).slice(0, 1200),
        })),
    )
    .slice(0, 12);
  return [sourceStatus, ...items];
}
