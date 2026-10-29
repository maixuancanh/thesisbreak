import { expect, it } from "vitest";
import { parseEspnSchedule } from "../../packages/integrations/src/news/espn-schedule";
it("preserves fallback provenance and never invents lineup confirmation", () => {
  const events = parseEspnSchedule(
    {
      events: [
        {
          id: "123",
          date: "2026-10-30T01:00:00Z",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { id: "1", abbreviation: "BOS" } },
                { homeAway: "away", team: { id: "2", abbreviation: "BKN" } },
              ],
              status: { type: { completed: false, state: "pre" } },
            },
          ],
        },
      ],
    },
    "2026-10-29T00:00:00Z",
  );
  expect(events[0]).toMatchObject({
    provider: "espn_public",
    officialNba: false,
    lineupConfirmed: false,
    status: "pending",
  });
});
it("rejects ambiguous identities", () => {
  expect(() =>
    parseEspnSchedule(
      {
        events: [
          {
            id: "123",
            date: "2026-10-30T01:00:00Z",
            competitions: [
              {
                competitors: [],
                status: { type: { completed: false, state: "pre" } },
              },
            ],
          },
        ],
      },
      "2026-10-29T00:00:00Z",
    ),
  ).toThrow("INVALID_EVENT_TEAMS");
});
