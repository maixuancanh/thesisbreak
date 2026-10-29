import { expect, it } from "vitest";
import { matchedBookmakerBaseline } from "../../packages/integrations/src/forecast-bookmaker";
it("requires exact identity, tipoff and fresh simultaneous two-way quote", () => {
  const target = {
      homeTeam: "BOS",
      awayTeam: "BKN",
      scheduledAt: "2026-10-30T00:00:00Z",
    },
    now = new Date("2026-10-29T23:00:00Z");
  const event = {
    provider: "the-odds-api" as const,
    eventId: "x",
    sport: "basketball_nba" as const,
    scheduledAt: target.scheduledAt,
    home: "Boston Celtics",
    away: "Brooklyn Nets",
    fetchedAt: now.toISOString(),
    rulesVerified: false as const,
    probabilityMethod: "proportional-margin-removal" as const,
    coverage: "observed" as const,
    quotes: [
      {
        bookmaker: "a",
        title: "A",
        asOf: now.toISOString(),
        margin: 0.05,
        outcomes: [
          { name: "Boston Celtics", decimalOdds: 1.8, probability: 0.55 },
          { name: "Brooklyn Nets", decimalOdds: 2.2, probability: 0.45 },
        ],
      },
    ],
  };
  expect(matchedBookmakerBaseline([event], target, now)?.probability).toBe(
    0.55,
  );
  expect(
    matchedBookmakerBaseline([event], { ...target, homeTeam: "NYK" }, now),
  ).toBeNull();
  expect(
    matchedBookmakerBaseline([event], target, new Date(now.getTime() + 301000)),
  ).toBeNull();
});
