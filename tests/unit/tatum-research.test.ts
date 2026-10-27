import { expect, it, vi } from "vitest";
import { TatumResearch } from "../../packages/integrations/src/tatum/research";
const id = "KXTEST-26";
const timestamp = "2026-10-27T00:00:00Z";
const side = { price: 0.4, bid: null, ask: 0.5, bidSize: null, askSize: 3 };
it("excludes one overlapping boundary candle without accepting unrelated history", async () => {
  const candle = {
    timestamp,
    open: 0.4,
    high: 0.5,
    low: 0.3,
    close: 0.4,
    volume: 1,
  };
  const data = {
    marketId: id,
    platform: "kalshi",
    interval: "1h",
    source: "candlesticks",
    candles: [candle, { ...candle, timestamp: "2026-10-27T01:00:00Z" }],
    partial: false,
    availableFrom: null,
  };
  const client = new TatumResearch("test", async () => Response.json({ data }));
  const r = await client.history({
    platform: "kalshi",
    id,
    interval: "1h",
    start: "2026-10-27T00:07:00Z",
    end: "2026-10-27T02:00:00Z",
  });
  expect(r.data.candles).toHaveLength(1);
  expect(r.data.partial).toBe(true);
  await expect(
    client.history({
      platform: "kalshi",
      id,
      interval: "1h",
      start: "2026-10-27T02:00:00Z",
      end: "2026-10-27T03:00:00Z",
    }),
  ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
});
it("reserves quote credits before network and preserves nullable quote semantics", async () => {
  const order: string[] = [];
  const client = new TatumResearch(
    "test",
    async () => {
      order.push("fetch");
      return Response.json({
        data: {
          marketId: id,
          platform: "kalshi",
          timestamp,
          yes: side,
          no: side,
          midPrice: null,
          spread: null,
          lastTradePrice: null,
          lastTradeAt: null,
          volume24h: null,
          volumeUnit: null,
        },
      });
    },
    async (cost) => {
      order.push(String(cost));
    },
  );
  const result = await client.quote({ platform: "kalshi", id });
  expect(order).toEqual(["100", "fetch"]);
  expect(result.data.midPrice).toBeNull();
  expect(result.data.timestamp).toBe(timestamp);
});
it("blocks invalid capability and oversized history before credits or network", async () => {
  const fetcher = vi.fn();
  const reserve = vi.fn();
  const client = new TatumResearch("test", fetcher, reserve);
  await expect(
    client.history({
      platform: "kalshi",
      id,
      interval: "1h",
      start: timestamp,
      end: "2026-10-28T00:00:00Z",
      source: "midpoint",
    }),
  ).rejects.toThrow();
  await expect(
    client.events({ platform: "kalshi", search: "team" }),
  ).rejects.toThrow();
  await expect(
    client.search({ platform: "kalshi" as "polymarket", q: "team" }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
});
it("keeps partial history and source, and refuses mismatched identity", async () => {
  const data = {
    marketId: id,
    platform: "kalshi",
    interval: "1h",
    source: "candlesticks",
    candles: [],
    partial: true,
    availableFrom: null,
  };
  const client = new TatumResearch("test", async () => Response.json({ data }));
  const result = await client.history({
    platform: "kalshi",
    id,
    interval: "1h",
    start: timestamp,
    end: "2026-10-28T00:00:00Z",
  });
  expect(result.data.partial).toBe(true);
  expect(result.data.availableFrom).toBeNull();
  await expect(
    client.quote({ platform: "kalshi", id: "KXOTHER" }),
  ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
});
it("reservation failure stops network unchanged", async () => {
  const fetcher = vi.fn();
  const error = new Error("BUDGET_EXHAUSTED");
  const client = new TatumResearch("test", fetcher, async () => {
    throw error;
  });
  await expect(client.quote({ platform: "kalshi", id })).rejects.toBe(error);
  expect(fetcher).not.toHaveBeenCalled();
});
