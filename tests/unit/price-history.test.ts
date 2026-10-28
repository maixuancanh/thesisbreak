import { describe, it, expect } from "vitest";
import { parseKalshiHistory } from "../../packages/integrations/src/price-history";
describe("price history", () => {
  it("preserves real trade closes and gaps without substituting bids or zero for absent prices", () => {
    expect(
      parseKalshiHistory({
        candlesticks: [
          { end_period_ts: 200, price: { close_dollars: "0.75" } },
          { end_period_ts: 100, price: {}, yes_bid: { close_dollars: "0.20" } },
          { end_period_ts: 300, price: { close_dollars: null } },
          { end_period_ts: 400, price: { close_dollars: "0" } },
          { end_period_ts: 500, price: { close_dollars: "2" } },
        ],
      }),
    ).toEqual([
      { time: 200, price: 0.75 },
      { time: 400, price: 0 },
    ]);
  });
  it("sorts and deduplicates timestamps and rejects malformed responses", () => {
    expect(
      parseKalshiHistory({
        candlesticks: [
          { end_period_ts: 20, price: { close_dollars: ".2" } },
          { end_period_ts: 10, price: { close_dollars: "0.1" } },
          { end_period_ts: 10, price: { close_dollars: "0.3" } },
        ],
      }),
    ).toEqual([{ time: 10, price: 0.3 }]);
    expect(() => parseKalshiHistory({ candlesticks: "bad" })).toThrow();
  });
});
