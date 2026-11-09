import { expect, it } from "vitest";
import { parseEspnOdds } from "../../packages/integrations/src/news/espn-odds";
const target = {
  eventId: "espn:123",
  scheduledAt: "2026-10-30T00:00:00Z",
  homeTeam: "BOS",
  awayTeam: "BKN",
};
const raw = {
  header: {
    id: "123",
    competitions: [
      {
        date: target.scheduledAt,
        competitors: [
          { id: "1", homeAway: "home", team: { abbreviation: "BOS" } },
          { id: "2", homeAway: "away", team: { abbreviation: "BKN" } },
        ],
      },
    ],
  },
  pickcenter: [
    {
      provider: { id: "100", name: "Published Book" },
      homeTeamOdds: { teamId: "1", moneyLine: -110 },
      awayTeamOdds: { teamId: "2", moneyLine: -110 },
    },
  ],
};
it("keeps public published bookmaker odds distinct from a verified timestamp-matched quote", () => {
  expect(parseEspnOdds(raw, target, "2026-10-29T00:00:00Z")).toMatchObject({
    probability: 0.5,
    sourceUpdatedAt: null,
    timestampMatched: false,
  });
});
it("rejects post-event and wrong-team data", () => {
  expect(() => parseEspnOdds(raw, target, "2026-10-30T01:00:00Z")).toThrow(
    "EVENT_STARTED",
  );
  expect(() =>
    parseEspnOdds(raw, { ...target, homeTeam: "NYK" }, "2026-10-29T00:00:00Z"),
  ).toThrow("ODDS_IDENTITY_MISMATCH");
});
