import { expect, it } from "vitest";
import { normalizePublicDecisionQuotes } from "../../packages/integrations/src/decision-quote-adapter";
const at = "2026-11-03T12:00:00Z";
const base = {
  ticker: "FIXTURE",
  status: "active",
  rules_primary: "Yes wins",
  rules_secondary: "Official settlement",
  yes_bid_dollars: "0.4000",
  yes_ask_dollars: "0.4400",
  yes_bid_size_fp: "10.00",
  yes_ask_size_fp: "20.00",
  last_price_dollars: "0.9",
  volume_fp: "10000",
};
it("records explicit Kalshi book midpoint with actual spread and supported outcome", () => {
  const [q] = normalizePublicDecisionQuotes(base, "kalshi", at);
  expect(q).toMatchObject({
    provider: "kalshi-public",
    marketId: "FIXTURE",
    outcomeId: "Yes",
    quoteType: "mid",
    probability: 0.42,
    spread: 0.04,
    status: "open",
    liquidityAvailable: true,
    observedAt: at,
  });
  expect(normalizePublicDecisionQuotes(base, "kalshi", at)).toHaveLength(1);
});
it.each([
  { yes_bid_size_fp: undefined },
  { yes_ask_size_fp: "0.00" },
  { yes_bid_dollars: "0.8" },
  { rules_primary: undefined, rules_secondary: undefined },
  { status: "suspended" },
])("does not infer book semantics from missing/invalid fields: %j", (patch) => {
  expect(
    normalizePublicDecisionQuotes({ ...base, ...patch }, "kalshi", at),
  ).toEqual([]);
});
it("Polymarket Gamma outcome_price does not masquerade as a comparable midpoint", () => {
  expect(
    normalizePublicDecisionQuotes(
      { outcomePrices: [0.6, 0.4], active: true, liquidityNum: 1000 },
      "polymarket",
      at,
    ),
  ).toEqual([]);
});
