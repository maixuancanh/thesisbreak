import { describe, it, expect, vi } from "vitest";
import {
  TEAM_NEWSROOMS,
  fetchFedReleases,
  fetchTeamAnnouncements,
  parseOfficialFeed,
} from "../../packages/integrations/src/news/feeds";
const now = new Date("2026-10-25T00:00:00Z");
const feedUrl = "https://www.federalreserve.gov/feeds/press_monetary.xml";
const item = `<item><title>Rate decision</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261001a.htm</link><description>Policy maintained</description><pubDate>Thu, 01 Oct 2026 18:00:00 GMT</pubDate></item>`;
const xml = (items: string) =>
  `<rss version="2.0"><channel>${items}</channel></rss>`;
describe("official source feeds", () => {
  it("contains only the 30 fixed NBA team routes", () => {
    expect(Object.keys(TEAM_NEWSROOMS)).toHaveLength(30);
    expect(TEAM_NEWSROOMS).toHaveProperty(
      "lakers.url",
      "https://www.nba.com/lakers/news",
    );
    expect(TEAM_NEWSROOMS).toHaveProperty(
      "warriors.url",
      "https://www.nba.com/warriors/news",
    );
    expect(TEAM_NEWSROOMS).toHaveProperty(
      "jazz.url",
      "https://www.nba.com/jazz/news",
    );
  });
  it("keeps publication time distinct from retrieval and deduplicates stable items", () => {
    const result = parseOfficialFeed(
      xml(item + item),
      "fed-official",
      feedUrl,
      now,
    );
    expect(result.state).toBe("available");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      publishedAt: "2026-10-01T18:00:00.000Z",
      retrievedAt: now.toISOString(),
      eventDate: null,
      teams: [],
    });
    expect(
      parseOfficialFeed(
        xml(item),
        "fed-official",
        feedUrl,
        new Date("2026-10-26Z"),
      ).items[0]?.id,
    ).toBe(result.items[0]?.id);
  });
  it("decodes official feed numeric entities into readable text", () => {
    expect(
      parseOfficialFeed(
        xml(item.replace("Rate decision", "Board&#39;s rate")),
        "fed-official",
        feedUrl,
        now,
      ).items[0]?.title,
    ).toBe("Board's rate");
  });
  it("never invents a publication time", () => {
    expect(
      parseOfficialFeed(
        xml(item.replace(/<pubDate>.*?<\/pubDate>/, "")),
        "fed-official",
        feedUrl,
        now,
      ).items[0]?.publishedAt,
    ).toBeNull();
  });
  it.each([
    "<!DOCTYPE rss><rss/>",
    "<rss>",
    xml(
      item.replace("www.federalreserve.gov/newsevents", "evil.test/newsevents"),
    ),
    "<html>Blocked</html>",
  ])("rejects invalid or unsafe feed %s", (value) => {
    expect(
      parseOfficialFeed(value, "fed-official", feedUrl, now),
    ).toMatchObject({ state: "invalid", items: [] });
  });
  it("requests only fixed Fed feed and reports transport failures", async () => {
    const transport = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        void url;
        void init;
        return new Response(xml(item), {
          headers: { "content-type": "text/xml" },
        });
      },
    );
    expect(
      (await fetchFedReleases({ transport: transport as typeof fetch, now }))
        .state,
    ).toBe("available");
    expect(String(transport.mock.calls[0]?.[0])).toBe(feedUrl);
    expect(
      await fetchFedReleases({
        transport: (async () => {
          throw new Error("secret");
        }) as typeof fetch,
      }),
    ).toEqual({ source: "fed-official", state: "unavailable", items: [] });
  });
  it("does not fetch arbitrary team slugs", async () => {
    const transport = vi.fn();
    expect(
      await fetchTeamAnnouncements("https://evil.test", { transport }),
    ).toEqual({ source: "team-official", state: "unconfigured", items: [] });
    expect(transport).not.toHaveBeenCalled();
  });
  it("reads reviewed Celtics listing metadata without inferring lineup status", async () => {
    const post = {
      type: "article",
      status: "publish",
      title: "Celtics announce update",
      permalink: "https://www.nba.com/celtics/news/update",
      excerpt: "Team announcement",
      date: "2026-10-24T03:59:00Z",
    };
    const body = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { pageObject: { contentExpanded: [{ content: [{ posts: [post, post] }] }] } } } })}</script>`;
    const result = await fetchTeamAnnouncements("celtics", {
      now,
      transport: (async () => new Response(body)) as typeof fetch,
    });
    expect(result.state).toBe("available");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: post.title,
      teams: ["Boston Celtics"],
      eventDate: null,
      publishedAt: "2026-10-24T03:59:00.000Z",
    });
    expect(result.items[0]?.status).toBeUndefined();
  });
  it.each([
    ["mavericks", "https://www.nba.com/mavs/news", "mavs", "pageObject"],
    ["sixers", "https://www.nba.com/sixers/", "sixers", "home"],
    [
      "raptors",
      "https://www.nba.com/raptors/news-media/recent-news",
      "raptors",
      "pageObject",
    ],
  ])(
    "uses reviewed %s listing route and schema",
    async (slug, url, articleSlug, key) => {
      const post = {
        type: "article",
        status: "publish",
        title: "Official announcement",
        permalink: `https://www.nba.com/${articleSlug}/news/update`,
        date: "2026-10-24T03:59:00Z",
      };
      const body = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { [key]: { contentExpanded: [{ posts: [post] }] } } } })}</script>`;
      const transport = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(url);
        return new Response(body);
      });
      const result = await fetchTeamAnnouncements(slug, {
        now,
        transport: transport as typeof fetch,
      });
      expect(result.state).toBe("available");
      expect(result.items).toHaveLength(1);
    },
  );
  it.each([
    ["nets", "1610612751"],
    ["grizzlies", "1610612763"],
    ["suns", "1610612756"],
  ])("uses reviewed official content API for %s", async (slug, teamId) => {
    const post = {
      type: "article",
      status: "publish",
      title: "Official announcement",
      permalink: `https://www.nba.com/${slug}/news/update`,
      excerpt: "Bounded summary",
      date: "2026-10-24T03:59:00Z",
      contentText: "Do not ingest full articles",
    };
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        `https://content-api-prod.nba.com/public/1/teams/${teamId}/content?types=article&count=20`,
      );
      return Response.json({ results: { count: 1, items: [post] } });
    });
    const result = await fetchTeamAnnouncements(slug, {
      now,
      transport: transport as typeof fetch,
    });
    expect(result.state).toBe("available");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.text).toBe("Bounded summary");
  });
  it("rejects external API article links and malformed source payloads", async () => {
    for (const body of [
      {
        results: {
          items: [
            {
              type: "article",
              status: "publish",
              title: "Bad",
              permalink: "https://evil.test/nets/news/x",
            },
          ],
        },
      },
      { results: { items: "not array" } },
    ]) {
      expect(
        await fetchTeamAnnouncements("nets", {
          transport: (async () => Response.json(body)) as typeof fetch,
        }),
      ).toMatchObject({ state: "invalid", items: [] });
    }
  });
});
