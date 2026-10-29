import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  fetchOfficialNbaGame,
  fetchOfficialNbaGameForMatch,
} from "../../packages/integrations/src/news/nba-game";

const schedulePage = (duplicate = false, selectedDate = "2025-06-22") => {
  // Actual /games?date page shape; explicit end time is separate from final status time.
  const card = {
    cardData: {
      gameId: "0042400407",
      homeTeam: { teamTricode: "OKC", teamId: 1610612760 },
      awayTeam: { teamTricode: "IND", teamId: 1610612754 },
      gameTimeUtc: "2025-06-23T00:00:00Z",
      actualEndTimeUTC: "2025-06-23T02:49:09Z",
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { hasError: false, selectedDate, gameCardFeed: { nextPageToken: null, modules: [{ cards: duplicate ? [card, card] : [card] }] } } } })}</script>`;
};

it("maps the unique official date/home/away game without relying on ESPN IDs", async () => {
  const schedule = schedulePage();
  const result = await fetchOfficialNbaGameForMatch(
    { eventDate: "2025-06-22", homeTeam: "OKC", awayTeam: "IND" },
    {
      transport: async (url) =>
        String(url).includes("/games?")
          ? new Response(schedule)
          : fallback(page(fixture()))(url),
    },
  );
  expect(result.state).toBe("available");
  expect(result.game?.gameId).toBe("0042400407");
  expect(result.endedAt).toBe("2025-06-23T02:49:09Z");
  expect(result.scheduleProvenance?.rawSha256).toBe(
    createHash("sha256").update(schedule).digest("hex"),
  );
  expect(result.game?.finalizedAt).toBeNull();
});

it.each([schedulePage(true), schedulePage(false, "2025-06-23")])(
  "rejects ambiguous mapping or a page serving a different date",
  async (body) => {
    const result = await fetchOfficialNbaGameForMatch(
      { eventDate: "2025-06-22", homeTeam: "OKC", awayTeam: "IND" },
      { transport: async () => new Response(body) },
    );
    expect(result.state).toBe("invalid");
    expect(result.game).toBeNull();
  },
);

const target = {
  gameId: "0042400407",
  eventDate: "2025-06-22",
  homeTeam: "OKC",
  awayTeam: "IND",
};
// Selected fields from live nba.com __NEXT_DATA__.props.pageProps.game, retrieved
// 2026-10-29. NBA page player positions exist; explicit starter flags do not.
const fixture = () => ({
  gameId: "0042400407",
  gameCode: "20250622/INDOKC",
  gameStatus: 3,
  gameStatusText: "Final",
  gameTimeUTC: "2025-06-23T00:00:00Z",
  homeTeamId: 1610612760,
  awayTeamId: 1610612754,
  homeTeam: {
    teamId: 1610612760,
    teamName: "Thunder",
    teamCity: "Oklahoma City",
    teamTricode: "OKC",
    score: 103,
    players: [
      {
        personId: 1631114,
        firstName: "Jalen",
        familyName: "Williams",
        position: "F",
      },
    ],
  },
  awayTeam: {
    teamId: 1610612754,
    teamName: "Pacers",
    teamCity: "Indiana",
    teamTricode: "IND",
    score: 91,
    players: [
      {
        personId: 1627783,
        firstName: "Pascal",
        familyName: "Siakam",
        position: "F",
      },
    ],
  },
});
const page = (game: unknown) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { game } } })}</script></html>`;
const fallback =
  (body: string): typeof fetch =>
  async (url) =>
    String(url).includes("cdn.nba.com")
      ? new Response("Access Denied", { status: 403 })
      : new Response(body);

it("uses the official page when CDN is forbidden; keeps hash and does not invent final time or starters", async () => {
  const body = page(fixture());
  const r = await fetchOfficialNbaGame(target, {
    transport: fallback(body),
    now: new Date("2026-10-29T01:00:00Z"),
  });
  expect(r.state).toBe("available");
  expect(r.game).toMatchObject({
    status: "final",
    homeScore: 103,
    awayScore: 91,
    finalizedAt: null,
    lineupConfirmed: false,
    starters: [],
    eventDate: "2025-06-22",
    scheduledAt: "2025-06-23T00:00:00Z",
  });
  expect(r.provenance).toMatchObject({
    sourceUrl: "https://www.nba.com/game/0042400407/box-score",
    rawSha256: createHash("sha256").update(body).digest("hex"),
    sourceUpdatedAt: null,
    retrievedAt: "2026-10-29T01:00:00.000Z",
  });
});

it.each([
  { gameId: "0042400406" },
  { eventDate: "2025-06-23" },
  { homeTeam: "IND", awayTeam: "OKC" },
  { gameId: "0042400407/../../evil" },
])("rejects identity mismatch or unsafe game target %j", async (change) => {
  const r = await fetchOfficialNbaGame(
    { ...target, ...change },
    { transport: fallback(page(fixture())) },
  );
  expect(r.state).toBe("invalid");
  expect(r.game).toBeNull();
});

it("does not settle live scores or contradictory final status", async () => {
  const live = fixture();
  live.gameStatus = 2;
  live.gameStatusText = "Q4 00:01";
  const r = await fetchOfficialNbaGame(target, {
    transport: fallback(page(live)),
  });
  expect(r.game).toMatchObject({ status: "live", finalizedAt: null });
  live.gameStatus = 3;
  expect(
    (await fetchOfficialNbaGame(target, { transport: fallback(page(live)) }))
      .state,
  ).toBe("invalid");
});

it("requires explicit five unique starters per side and preserves source timestamp separately", async () => {
  const game = fixture();
  const players = (base: number) =>
    Array.from({ length: 5 }, (_, i) => ({
      personId: base + i,
      firstName: "Player",
      familyName: String(i),
      starter: "1",
    }));
  const raw = {
    meta: { time: "2025-06-23T03:10:00Z" },
    game: {
      ...game,
      homeTeam: { ...game.homeTeam, players: players(100) },
      awayTeam: { ...game.awayTeam, players: players(200) },
    },
  };
  const r = await fetchOfficialNbaGame(target, {
    transport: async () => Response.json(raw),
  });
  expect(r.game).toMatchObject({ lineupConfirmed: true, finalizedAt: null });
  expect(r.game?.starters).toHaveLength(10);
  expect(r.provenance?.sourceUpdatedAt).toBe("2025-06-23T03:10:00Z");
});

it("fails closed for unavailable feeds, oversized bodies, ties and malformed data", async () => {
  expect(
    (
      await fetchOfficialNbaGame(target, {
        transport: async () => new Response("", { status: 503 }),
      })
    ).state,
  ).toBe("unavailable");
  expect(
    (
      await fetchOfficialNbaGame(target, {
        transport: async () => new Response("oops"),
      })
    ).state,
  ).toBe("invalid");
  expect(
    (
      await fetchOfficialNbaGame(target, {
        transport: async () =>
          new Response("x", { headers: { "content-length": "9000000" } }),
      })
    ).state,
  ).toBe("unavailable");
  const game = fixture();
  game.homeTeam.score = 91;
  expect(
    (await fetchOfficialNbaGame(target, { transport: fallback(page(game)) }))
      .state,
  ).toBe("invalid");
});
