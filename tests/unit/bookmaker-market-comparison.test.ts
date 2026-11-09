import { expect, it } from "vitest";
import { normalizeBookmakerEvent } from "../../packages/integrations/src/bookmaker";
import { compareBookmakerMarket } from "../../packages/integrations/src/bookmaker-market-comparison";

const now = new Date("2026-11-05T12:00:00Z");
const bookmaker = normalizeBookmakerEvent(
  {
    id: "nba-1",
    sport_key: "basketball_nba",
    commence_time: "2026-11-06T00:00:00Z",
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
  },
  now,
);
const market = {
  provider: "tatum" as const,
  fetchedAt: now.toISOString(),
  data: {
    marketId: "0x" + "1".repeat(64),
    platform: "polymarket" as const,
    timestamp: now.toISOString(),
    yes: { price: 0.6 },
    no: { price: 0.4 },
  },
};
const mapping = {
  marketId: market.data.marketId,
  platform: "polymarket" as const,
  home: bookmaker.home,
  away: bookmaker.away,
  scheduledAt: bookmaker.scheduledAt,
  yesOutcome: bookmaker.home,
  noOutcome: bookmaker.away,
  marketType: "full_game_winner",
  sourceUrl: "https://polymarket.com/event/boston-brooklyn",
  reviewedAt: now.toISOString(),
};
const rules = {
  bookmaker: {
    sourceUrl: "https://example.com/book/rules",
    reviewedAt: now.toISOString(),
    overtime: "included",
    postponement: "void",
    abandonment: "void",
  },
  market: {
    sourceUrl: mapping.sourceUrl,
    reviewedAt: now.toISOString(),
    overtime: "included",
    postponement: "void",
    abandonment: "void",
  },
};
const input = { bookmaker, bookmakerKey: "book", market, mapping, rules, now };

it("only exposes a descriptive gap after exact outcome, fresh prices and reviewed rule alignment", () => {
  const result = compareBookmakerMarket(input);
  expect(result.status).toBe("reviewed_compatible");
  expect(result.homeProbabilityGap).toBeCloseTo(0.05);
  expect(result.settlementRulesVerified).toBe(false);
  expect(result.chainVerified).toBe(false);
  expect(result.marketEvidence).toBe("tatum_api_quote");
  expect(result.provenance.bookmakerAsOf).toBe(now.toISOString());
  expect(result.provenance.bookmakerOutcomes).toHaveLength(2);
  expect(result.provenance.marketPrices).toEqual({ yes: 0.6, no: 0.4 });
  expect(result.policy).toEqual({
    maximumAgeSeconds: 300,
    maximumSkewSeconds: 120,
  });
});

it("keeps unknown settlement rules from becoming an actionable price gap", () => {
  const result = compareBookmakerMarket({ ...input, rules: null });
  expect(result.rules).toBe("unverified");
  expect(result.status).toBe("incomplete");
  expect(result.homeProbabilityGap).toBeNull();
});

it("reports mismatched postponement rules even for identical event prices", () => {
  const result = compareBookmakerMarket({
    ...input,
    rules: {
      ...rules,
      market: { ...rules.market, postponement: "rescheduled" },
    },
  });
  expect(result.rules).toBe("different");
  expect(result.status).toBe("incompatible");
  expect(result.homeProbabilityGap).toBeNull();
});

it("requires an independently reviewed market outcome mapping", () => {
  expect(compareBookmakerMarket({ ...input, mapping: null }).identity).toBe(
    "unverified",
  );
  expect(
    compareBookmakerMarket({
      ...input,
      mapping: { ...mapping, yesOutcome: "Over 200" },
    }).outcome,
  ).toBe("different");
  expect(
    compareBookmakerMarket({
      ...input,
      mapping: { ...mapping, marketId: "other" },
    }).identity,
  ).toBe("different");
  expect(
    compareBookmakerMarket({
      ...input,
      mapping: { ...mapping, scheduledAt: "2026-11-07T00:00:00Z" },
    }).identity,
  ).toBe("different");
});

it("maps a reviewed away-team YES quote back to the bookmaker home-team outcome", () => {
  const result = compareBookmakerMarket({
    ...input,
    mapping: {
      ...mapping,
      yesOutcome: bookmaker.away,
      noOutcome: bookmaker.home,
    },
  });
  expect(result.homeProbabilityGap).toBeCloseTo(-0.15);
});

it("blocks stale, future, missing and unsynchronized source timestamps", () => {
  for (const timestamp of [
    "2026-11-05T11:54:59Z",
    "2026-11-05T12:00:01Z",
    "invalid",
  ]) {
    const result = compareBookmakerMarket({
      ...input,
      market: { ...market, data: { ...market.data, timestamp } },
    });
    expect(result.status).toBe("incomplete");
    expect(result.homeProbabilityGap).toBeNull();
  }
  expect(
    compareBookmakerMarket({
      ...input,
      market: {
        ...market,
        data: { ...market.data, timestamp: "2026-11-05T11:57:59Z" },
      },
    }).freshness,
  ).toBe("unsynchronized");
});

it("rejects quotes after event start and never treats Kalshi as chain proof", () => {
  expect(
    compareBookmakerMarket({ ...input, now: new Date(bookmaker.scheduledAt) })
      .status,
  ).toBe("incompatible");
  const result = compareBookmakerMarket({
    ...input,
    market: {
      ...market,
      data: { ...market.data, platform: "kalshi", marketId: "KXNBA-TEST" },
    },
    mapping: {
      ...mapping,
      platform: "kalshi",
      marketId: "KXNBA-TEST",
      sourceUrl: "https://kalshi.com/markets/test",
    },
  });
  expect(result.status).toBe("reviewed_compatible");
  expect(result.chainVerified).toBe(false);
  expect(result.marketEvidence).toBe("tatum_api_quote");
});

it("fails closed on missing quote, ambiguous bookmaker and incomplete rule citations", () => {
  expect(
    compareBookmakerMarket({ ...input, bookmakerKey: "missing" }).status,
  ).toBe("incomplete");
  expect(
    compareBookmakerMarket({
      ...input,
      bookmaker: {
        ...bookmaker,
        quotes: [...bookmaker.quotes, ...bookmaker.quotes],
      },
    }).status,
  ).toBe("incomplete");
  expect(
    compareBookmakerMarket({
      ...input,
      rules: { ...rules, market: { ...rules.market, sourceUrl: "" } },
    }).rules,
  ).toBe("unverified");
  expect(
    compareBookmakerMarket({
      ...input,
      rules: { ...rules, market: { ...rules.market, overtime: "unknown" } },
    }).rules,
  ).toBe("unverified");
});
