import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { boundedRead } from "./http";
export type NewsItem = {
  id: string;
  url: string;
  title: string;
  text: string;
  publishedAt: string | null;
  retrievedAt: string;
  eventDate: string | null;
  teams: string[];
  player?: string;
  status?: string;
};
export type NewsResult = {
  source: "fed-official" | "team-official";
  state: "available" | "unavailable" | "invalid" | "unconfigured";
  items: NewsItem[];
};
type Options = { transport?: typeof fetch; now?: Date };
const FED_URL = "https://www.federalreserve.gov/feeds/press_monetary.xml";
// Fixed NBA team newsroom routes. Availability is checked per response; no league-wide coverage claim.
export const TEAM_NEWSROOMS = {
  hawks: { url: "https://www.nba.com/hawks/news", name: "Atlanta Hawks" },
  celtics: { url: "https://www.nba.com/celtics/news", name: "Boston Celtics" },
  nets: { url: "https://www.nba.com/nets/news", name: "Brooklyn Nets" },
  hornets: {
    url: "https://www.nba.com/hornets/news",
    name: "Charlotte Hornets",
  },
  bulls: { url: "https://www.nba.com/bulls/news", name: "Chicago Bulls" },
  cavaliers: {
    url: "https://www.nba.com/cavaliers/news",
    name: "Cleveland Cavaliers",
  },
  mavericks: {
    url: "https://www.nba.com/mavs/news",
    name: "Dallas Mavericks",
  },
  nuggets: { url: "https://www.nba.com/nuggets/news", name: "Denver Nuggets" },
  pistons: { url: "https://www.nba.com/pistons/news", name: "Detroit Pistons" },
  warriors: {
    url: "https://www.nba.com/warriors/news",
    name: "Golden State Warriors",
  },
  rockets: { url: "https://www.nba.com/rockets/news", name: "Houston Rockets" },
  pacers: { url: "https://www.nba.com/pacers/news", name: "Indiana Pacers" },
  clippers: { url: "https://www.nba.com/clippers/news", name: "LA Clippers" },
  lakers: {
    url: "https://www.nba.com/lakers/news",
    name: "Los Angeles Lakers",
  },
  grizzlies: {
    url: "https://www.nba.com/grizzlies/news",
    name: "Memphis Grizzlies",
  },
  heat: { url: "https://www.nba.com/heat/news", name: "Miami Heat" },
  bucks: { url: "https://www.nba.com/bucks/news", name: "Milwaukee Bucks" },
  timberwolves: {
    url: "https://www.nba.com/timberwolves/news",
    name: "Minnesota Timberwolves",
  },
  pelicans: {
    url: "https://www.nba.com/pelicans/news",
    name: "New Orleans Pelicans",
  },
  knicks: { url: "https://www.nba.com/knicks/news", name: "New York Knicks" },
  thunder: {
    url: "https://www.nba.com/thunder/news",
    name: "Oklahoma City Thunder",
  },
  magic: { url: "https://www.nba.com/magic/news", name: "Orlando Magic" },
  sixers: {
    url: "https://www.nba.com/sixers/",
    name: "Philadelphia 76ers",
  },
  suns: { url: "https://www.nba.com/suns/news", name: "Phoenix Suns" },
  kings: { url: "https://www.nba.com/kings/news", name: "Sacramento Kings" },
  spurs: { url: "https://www.nba.com/spurs/news", name: "San Antonio Spurs" },
  raptors: {
    url: "https://www.nba.com/raptors/news-media/recent-news",
    name: "Toronto Raptors",
  },
  jazz: { url: "https://www.nba.com/jazz/news", name: "Utah Jazz" },
  wizards: {
    url: "https://www.nba.com/wizards/news",
    name: "Washington Wizards",
  },
  blazers: {
    url: "https://www.nba.com/blazers/news",
    name: "Portland Trail Blazers",
  },
} as const;
// Official team-content API advertised by the Suns site; each fixed team's
// article listing and same-team permalinks were verified independently.
const TEAM_CONTENT_API: Readonly<Record<string, string>> = {
  nets: "https://content-api-prod.nba.com/public/1/teams/1610612751/content?types=article&count=20",
  grizzlies:
    "https://content-api-prod.nba.com/public/1/teams/1610612763/content?types=article&count=20",
  suns: "https://content-api-prod.nba.com/public/1/teams/1610612756/content?types=article&count=20",
};
const result = (
  source: NewsResult["source"],
  state: NewsResult["state"],
  items: NewsItem[] = [],
): NewsResult => ({ source, state, items });
function clean(value: unknown, limit: number): string {
  return typeof value === "string"
    ? value
        .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, digits: string) => {
          const point =
            digits[0]?.toLowerCase() === "x"
              ? parseInt(digits.slice(1), 16)
              : Number(digits);
          return point > 0 &&
            point <= 0x10ffff &&
            !(point >= 0xd800 && point <= 0xdfff)
            ? String.fromCodePoint(point)
            : "";
        })
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";
}
function date(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(value.trim())
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function officialUrl(
  value: unknown,
  source: NewsResult["source"],
  teamSlug?: string,
): string {
  if (typeof value !== "string") throw new Error("INVALID_LINK");
  const url = new URL(value);
  const valid =
    source === "fed-official"
      ? url.hostname === "www.federalreserve.gov" &&
        url.pathname.startsWith("/newsevents/pressreleases/")
      : url.hostname === "www.nba.com" &&
        Boolean(teamSlug) &&
        url.pathname.startsWith(`/${teamSlug}/news/`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !valid
  )
    throw new Error("INVALID_LINK");
  url.hash = "";
  return url.href;
}
function entry(
  url: string,
  title: string,
  text: string,
  publishedAt: string | null,
  now: Date,
  teams: string[],
): NewsItem {
  return {
    id: createHash("sha256")
      .update(JSON.stringify([url, title, text, publishedAt]))
      .digest("hex"),
    url,
    title,
    text,
    publishedAt,
    retrievedAt: now.toISOString(),
    eventDate: null,
    teams,
  };
}
const unique = (items: NewsItem[]) => [
  ...new Map(items.map((item) => [item.id, item])).values(),
];
export function parseOfficialFeed(
  xml: string,
  source: NewsResult["source"],
  feedUrl: string,
  now: Date,
  teams: string[] = [],
): NewsResult {
  try {
    if (
      Buffer.byteLength(xml) > 2 * 1024 * 1024 ||
      /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) ||
      XMLValidator.validate(xml) !== true
    )
      return result(source, "invalid");
    if (source !== "fed-official" || feedUrl !== FED_URL)
      return result(source, "invalid");
    const parsed = new XMLParser({
      ignoreAttributes: true,
      processEntities: true,
      parseTagValue: false,
    }).parse(xml);
    if (!parsed.rss?.channel || typeof parsed.rss.channel !== "object")
      return result(source, "invalid");
    const raw = parsed.rss.channel.item ?? [];
    const items = (Array.isArray(raw) ? raw : [raw])
      .slice(0, 200)
      .map((item: Record<string, unknown>) => {
        const url = officialUrl(item.link, source);
        const title = clean(item.title, 500);
        if (!title) throw new Error("INVALID_TITLE");
        return entry(
          url,
          title,
          clean(item.description, 4000),
          date(item.pubDate),
          now,
          teams,
        );
      });
    return result(source, "available", unique(items));
  } catch {
    return result(source, "invalid");
  }
}
export async function fetchFedReleases(
  options: Options = {},
): Promise<NewsResult> {
  try {
    const body = new TextDecoder().decode(
      await boundedRead(FED_URL, ["www.federalreserve.gov"], options),
    );
    return parseOfficialFeed(
      body,
      "fed-official",
      FED_URL,
      options.now ?? new Date(),
    );
  } catch {
    return result("fed-official", "unavailable");
  }
}
export async function fetchTeamAnnouncements(
  teamSlug: string,
  options: Options = {},
): Promise<NewsResult> {
  if (!Object.hasOwn(TEAM_NEWSROOMS, teamSlug))
    return result("team-official", "unconfigured");
  const config = TEAM_NEWSROOMS[teamSlug as keyof typeof TEAM_NEWSROOMS];
  let body: string;
  try {
    body = new TextDecoder().decode(
      await boundedRead(
        TEAM_CONTENT_API[teamSlug] ?? config.url,
        TEAM_CONTENT_API[teamSlug]
          ? ["content-api-prod.nba.com"]
          : ["www.nba.com"],
        options,
      ),
    );
  } catch {
    return result("team-official", "unavailable");
  }
  try {
    let root: unknown;
    if (TEAM_CONTENT_API[teamSlug]) {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload?.results?.items))
        return result("team-official", "invalid");
      root = [{ posts: payload.results.items }];
    } else {
      // Extract one JSON script payload; never interpret or execute HTML.
      const payload =
        /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i.exec(
          body,
        )?.[1];
      if (!payload) return result("team-official", "invalid");
      const pageProps = JSON.parse(payload)?.props?.pageProps;
      root = (teamSlug === "sixers" ? pageProps?.home : pageProps?.pageObject)
        ?.contentExpanded;
    }
    if (!Array.isArray(root)) return result("team-official", "invalid");
    const items: NewsItem[] = [];
    function walk(nodes: unknown[], depth = 0) {
      if (depth > 8) throw new Error("INVALID_DEPTH");
      for (const node of nodes.slice(0, 200)) {
        if (!node || typeof node !== "object") continue;
        const value = node as Record<string, unknown>;
        if (Array.isArray(value.posts))
          for (const post of value.posts.slice(0, 100)) {
            if (post.type !== "article" || post.status !== "publish") continue;
            const title = clean(post.title, 500);
            if (!title) throw new Error("INVALID_TITLE");
            items.push(
              entry(
                officialUrl(
                  post.permalink,
                  "team-official",
                  new URL(config.url).pathname.split("/")[1],
                ),
                title,
                clean(post.excerpt, 4000),
                date(post.date),
                options.now ?? new Date(),
                [config.name],
              ),
            );
          }
        if (Array.isArray(value.content)) walk(value.content, depth + 1);
      }
    }
    walk(root);
    return result("team-official", "available", unique(items));
  } catch {
    return result("team-official", "invalid");
  }
}
