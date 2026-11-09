import { describe, expect, it } from "vitest";
import {
  fetchNbaHistory,
  historyForElo,
  parseEspnHistory,
  restBeforeGame,
} from "../../packages/integrations/src/news/nba-history";

const observed = "2026-10-29T06:00:00.000Z";
function event(
  id: string,
  date: string,
  home = "BOS",
  away = "BKN",
  completed = true,
) {
  return {
    id,
    date,
    competitions: [
      {
        id,
        neutralSite: false,
        status: {
          type: {
            completed,
            state: completed ? "post" : "pre",
            name: completed ? "STATUS_FINAL" : "STATUS_SCHEDULED",
          },
        },
        competitors: [
          {
            homeAway: "home",
            team: { id: home, abbreviation: home },
            score: "115",
          },
          {
            homeAway: "away",
            team: { id: away, abbreviation: away },
            score: "100",
          },
        ],
      },
    ],
  };
}
const parse = (events: unknown[]) =>
  parseEspnHistory(
    { events },
    {
      retrievedAt: observed,
      sourceUrl:
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261027",
      sha256: "a".repeat(64),
    },
  );
describe("public NBA history", () => {
  it("retains publisher identity and observation time without inventing final publication", () => {
    const [game] = parse([event("401909877", "2026-10-27T23:30Z")]);
    expect(game).toMatchObject({
      eventId: "espn:401909877",
      scheduledAt: "2026-10-27T23:30:00.000Z",
      finalObservedAt: observed,
      resolvedAt: observed,
      homeScore: 115,
      provider: "espn_public",
      officialNba: false,
      resultPublishedAt: null,
    });
  });
  it("normalizes ESPN aliases into canonical NBA team codes", () => {
    expect(
      parse([event("1", "2026-10-27T23:30Z", "UTAH", "GS")])[0],
    ).toMatchObject({ homeTeam: "UTA", awayTeam: "GSW" });
    expect(
      parse([event("2", "2026-10-27T23:30Z", "NY", "NO")])[0],
    ).toMatchObject({ homeTeam: "NYK", awayTeam: "NOP" });
  });
  it("strips unfinished scores, rejects future finals, duplicate IDs and tied final results", () => {
    expect(
      parse([event("1", "2026-10-30T23:30Z", "BOS", "BKN", false)])[0],
    ).toMatchObject({
      homeScore: null,
      awayScore: null,
      finalObservedAt: null,
    });
    expect(() => parse([event("1", "2026-10-30T23:30Z")])).toThrow(
      "INVALID_FINAL",
    );
    expect(() =>
      parse([event("1", "2026-10-27T23:30Z"), event("1", "2026-10-27T23:30Z")]),
    ).toThrow("DUPLICATE_EVENT");
    const tied = event("1", "2026-10-27T23:30Z");
    tied.competitions[0]!.competitors[1]!.score = "115";
    expect(() => parse([tied])).toThrow("INVALID_FINAL");
  });
  it("derives rest from prior starts chronologically and abstains on unknown rest", () => {
    const records = parse([
      event("2", "2026-10-27T23:30Z"),
      event("1", "2026-10-25T23:30Z"),
    ]);
    expect(
      restBeforeGame(records, "BOS", "BKN", "2026-10-28T23:30:00Z"),
    ).toMatchObject({ homeRestDays: 0, awayRestDays: 0 });
    expect(
      restBeforeGame(records, "LAL", "BKN", "2026-10-28T23:30:00Z"),
    ).toBeNull();
    const eligible = historyForElo(records, "2026-10-30T00:00:00Z");
    expect(eligible.games).toHaveLength(1);
    expect(eligible.games[0]).toMatchObject({
      eventId: "espn:2",
      homeRestDays: 1,
      awayRestDays: 1,
    });
    expect(eligible.excluded[0]?.reason).toBe("missing_prior_start");
  });
  it("cannot expose freshly backfilled scores to a historical prediction", () => {
    const records = parse([
      event("1", "2026-10-25T23:30Z"),
      event("2", "2026-10-27T23:30Z"),
    ]);
    expect(historyForElo(records, "2026-10-28T00:00:00Z").games).toEqual([]);
    expect(historyForElo(records, observed).games).toEqual([]);
  });
  it("bounds dates, verifies snapshots and fails on unavailable feeds", async () => {
    const snapshots: unknown[] = [];
    const result = await fetchNbaHistory({
      startDate: "2026-10-27",
      endDate: "2026-10-27",
      now: new Date(observed),
      transport: (async (_url, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(
          JSON.stringify({ events: [event("1", "2026-10-27T23:30Z")] }),
        );
      }) as typeof fetch,
      onSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
    });
    expect(result.records).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      fetchNbaHistory({
        startDate: "2026-01-01",
        endDate: "2026-10-27",
        now: new Date(observed),
      }),
    ).rejects.toThrow("DATE_RANGE");
    await expect(
      fetchNbaHistory({ startDate: "2026-02-30", endDate: "2026-03-01" }),
    ).rejects.toThrow("INVALID_DATE");
    await expect(
      fetchNbaHistory({
        startDate: "2026-10-30",
        endDate: "2026-10-30",
        now: new Date(observed),
      }),
    ).rejects.toThrow("FUTURE_DATE");
    await expect(
      fetchNbaHistory({
        startDate: "2026-10-27",
        endDate: "2026-10-27",
        now: new Date(observed),
        transport: (async () =>
          new Response("blocked", { status: 403 })) as typeof fetch,
      }),
    ).rejects.toThrow("HISTORY_UNAVAILABLE");
  });
});
