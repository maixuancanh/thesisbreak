import { describe, expect, it } from "vitest";
import { fetchBallDontLie } from "../../packages/integrations/src/news/balldontlie";
const target = {
  eventDate: "2026-10-25",
  teams: ["Los Angeles Lakers", "Boston Celtics"],
};
const game = {
  id: 10,
  date: target.eventDate,
  status: "Scheduled",
  home_team: { id: 14, full_name: target.teams[0] },
  visitor_team: { id: 2, full_name: target.teams[1] },
};
const player = { id: 23, first_name: "Test", last_name: "Player", team_id: 14 };
function wire(bodies: unknown[], statuses: number[] = []) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  return {
    calls,
    transport: (async (url, init) => {
      calls.push({ url: new URL(String(url)), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(bodies[calls.length - 1]), {
        status: statuses[calls.length - 1] ?? 200,
      });
    }) as typeof fetch,
  };
}
describe("BALLDONTLIE fixed NBA source", () => {
  it("does not call without a key", async () => {
    const w = wire([]);
    expect(
      (await fetchBallDontLie(target, { apiKey: "", transport: w.transport }))
        .state,
    ).toBe("unconfigured");
    expect(w.calls).toHaveLength(0);
  });
  it("defaults to one exact-date games request and fixed-host authentication", async () => {
    const w = wire([{ data: [game] }]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
    });
    expect(r.state).toBe("available");
    expect(r.items[0]).toMatchObject({
      eventDate: target.eventDate,
      publishedAt: null,
      status: "Scheduled",
    });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.url.pathname).toBe("/nba/v1/games");
    expect(w.calls[0]?.url.searchParams.get("dates[]")).toBe(target.eventDate);
    expect(new Headers(w.calls[0]?.init?.headers).get("Authorization")).toBe(
      "secret",
    );
    expect(w.calls[0]?.init?.redirect).toBe("error");
  });
  it.each([
    [{ ...game, date: "2026-10-24" }],
    [game, { ...game, id: 11 }],
    [{ ...game, visitor_team: { id: 2, full_name: "Celtics" } }],
  ])(
    "rejects wrong dates, ambiguous games and partial team names",
    async (...games) => {
      const w = wire([{ data: games }]);
      expect(
        (
          await fetchBallDontLie(target, {
            apiKey: "secret",
            transport: w.transport,
          })
        ).state,
      ).toBe("invalid");
    },
  );
  it("rejects impossible target dates before transport", async () => {
    const w = wire([]);
    expect(
      (
        await fetchBallDontLie(
          { ...target, eventDate: "2026-02-30" },
          { apiKey: "secret", transport: w.transport },
        )
      ).state,
    ).toBe("invalid");
    expect(w.calls).toHaveLength(0);
  });
  it("keeps injuries undated and does not infer a lineup or availability", async () => {
    const w = wire([
      { data: [game] },
      {
        data: [
          {
            player,
            status: "Out",
            description: "Shoulder",
            return_date: "Oct 29",
          },
        ],
        meta: { next_cursor: null },
      },
    ]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
      features: "injuries",
    });
    expect(r.state).toBe("available");
    expect(r.items[1]).toMatchObject({
      player: "Test Player",
      status: "Out",
      eventDate: null,
      publishedAt: null,
    });
    expect(w.calls[1]?.url.searchParams.getAll("team_ids[]")).toEqual([
      "14",
      "2",
    ]);
    expect(r.items[1]?.text).not.toContain("starter");
  });
  it("validates lineup game and team/player binding", async () => {
    const w = wire([
      { data: [game] },
      {
        data: [
          { id: 5, game_id: 11, starter: true, player, team: game.home_team },
        ],
      },
    ]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
      features: "lineups",
    });
    expect(r.state).toBe("invalid");
    expect(r.items).toHaveLength(1);
  });
  it("reports explicit starter facts only from lineups", async () => {
    const w = wire([
      { data: [game] },
      {
        data: [
          { id: 5, game_id: 10, starter: false, player, team: game.home_team },
        ],
        meta: { next_cursor: null },
      },
    ]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
      features: "lineups",
    });
    expect(r.state).toBe("available");
    expect(r.items[1]).toMatchObject({
      status: "bench",
      eventDate: target.eventDate,
    });
  });
  it.each([
    [403, "access_required"],
    [429, "rate_limited"],
  ])("preserves games and paid feed failure %i", async (code, state) => {
    const w = wire([{ data: [game] }, {}], [200, code as number]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
      features: "injuries",
    });
    expect(r.state).toBe(state);
    expect(r.items).toHaveLength(1);
    expect(r.detail).toContain("injuries");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("bounds pagination and signals partial feed", async () => {
    const w = wire([
      { data: [game] },
      ...Array.from({ length: 4 }, (_, i) => ({
        data: [],
        meta: { next_cursor: i + 1 },
      })),
    ]);
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: w.transport,
      features: "injuries",
    });
    expect(w.calls).toHaveLength(5);
    expect(r.state).toBe("partial");
  });
  it("redacts transport errors", async () => {
    const r = await fetchBallDontLie(target, {
      apiKey: "secret",
      transport: (async () => {
        throw new Error("secret");
      }) as typeof fetch,
    });
    expect(r.state).toBe("unavailable");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
