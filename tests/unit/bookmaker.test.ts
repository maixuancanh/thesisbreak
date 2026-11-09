import { expect, it, vi } from "vitest";
import {
  BookmakerAdapter,
  normalizeBookmakerEvent,
} from "../../packages/integrations/src/bookmaker";
const now = new Date("2026-10-27T10:00:00Z");
const row = {
  id: "nba-1",
  sport_key: "basketball_nba",
  commence_time: "2026-10-27T11:00:00Z",
  home_team: "Boston Celtics",
  away_team: "Brooklyn Nets",
  bookmakers: [
    {
      key: "book",
      title: "Book",
      last_update: now.toISOString(),
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: "Boston Celtics", price: 1.8 },
            { name: "Brooklyn Nets", price: 2.2 },
          ],
        },
      ],
    },
  ],
};
it("normalizes decimal odds without pretending normalized probabilities are truth", () => {
  const x = normalizeBookmakerEvent(row, now);
  expect(x.quotes[0]?.outcomes[0]?.probability).toBeCloseTo(0.55);
  expect(x.quotes[0]?.margin).toBeCloseTo(1 / 1.8 + 1 / 2.2 - 1);
  expect(x.rulesVerified).toBe(false);
});
it("does not compare stale or non-binary markets or use only one side", () => {
  expect(
    normalizeBookmakerEvent(
      {
        ...row,
        bookmakers: [
          { ...row.bookmakers[0], last_update: "2026-10-27T09:00:00Z" },
        ],
      },
      now,
    ).quotes,
  ).toHaveLength(0);
  expect(
    normalizeBookmakerEvent(
      {
        ...row,
        bookmakers: [
          {
            ...row.bookmakers[0],
            markets: [
              {
                key: "h2h",
                outcomes: [{ name: "Boston Celtics", price: 1.8 }],
              },
            ],
          },
        ],
      },
      now,
    ).quotes,
  ).toHaveLength(0);
});
it("reserves quota before networking and never puts the key in returned data", async () => {
  const reserve = vi.fn(async () => {});
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    expect(new URL(String(url)).hostname).toBe("api.the-odds-api.com");
    return new Response(JSON.stringify([row]), {
      headers: { "x-requests-remaining": "499" },
    });
  });
  const a = new BookmakerAdapter("private-test-key", reserve, fetcher);
  const r = await a.nba(now);
  expect(reserve).toHaveBeenCalledWith(1);
  expect(r.quotaRemaining).toBe(499);
  expect(JSON.stringify(r)).not.toContain("private-test-key");
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("markets=h2h");
});
it("fails closed when key or quota is unavailable", async () => {
  expect(() => new BookmakerAdapter("", async () => {})).toThrow(
    "BOOKMAKER_NOT_CONFIGURED",
  );
  const fetcher = vi.fn();
  await expect(
    new BookmakerAdapter(
      "key",
      async () => {
        throw new Error("BUDGET_EXCEEDED");
      },
      fetcher,
    ).nba(now),
  ).rejects.toThrow("BUDGET_EXCEEDED");
  expect(fetcher).not.toHaveBeenCalled();
});
