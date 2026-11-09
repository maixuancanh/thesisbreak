import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  parseEspnSchedule,
  readEspnSchedule,
} from "../../packages/integrations/src/news/espn-schedule";
it("retains exact source response bytes and their digest before returning events", async () => {
  const body = ' { "events": [] }\n';
  const snapshots: unknown[] = [];
  const events = await readEspnSchedule(
    "20261029",
    async () => new Response(body),
    async (snapshot) => {
      snapshots.push(snapshot);
    },
  );
  expect(events).toEqual([]);
  expect(snapshots[0]).toMatchObject({
    body,
    contentHash: createHash("sha256").update(body).digest("hex"),
    sourceUrl:
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261029&limit=100",
  });
});
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
