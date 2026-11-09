import { describe, expect, it } from "vitest";
import { PublicCatalog } from "../../packages/integrations/src/public-catalog";
const kalshi = {
  ticker: "KXDEMO-26-YES",
  title: "Will A win?",
  event_ticker: "KXDEMO-26",
  last_price_dollars: "0.4200",
  volume_fp: "20.00",
  close_time: "2026-11-01T00:00:00Z",
  updated_time: "2026-10-22T00:00:00Z",
  rules_primary: "A wins in regular time",
  rules_secondary: "No extra time",
};
describe("official public catalog offline", () => {
  it("loads Polymarket sibling conditions from the verified event envelope", async () => {
    const conditionId = `0x${"b".repeat(64)}`;
    const payload = {
      id: "42",
      title: "Election",
      markets: [
        {
          id: "1",
          conditionId,
          question: "A wins?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.6","0.4"]',
        },
      ],
    };
    const catalog = new PublicCatalog(async () => Response.json(payload));
    const event = await catalog.eventMarkets("42", "polymarket");
    expect(event.provider).toBe("polymarket-public");
    expect(event.data[0]).toMatchObject({
      id: conditionId,
      eventId: "42",
      eventTitle: "Election",
    });
    await expect(
      new PublicCatalog(async () =>
        Response.json({ ...payload, id: "99" }),
      ).eventMarkets("42", "polymarket"),
    ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
  });
  it("maps Yes and No histories by outcome name, not token position or a guessed complement", async () => {
    const id = `0x${"c".repeat(64)}`;
    const catalog = new PublicCatalog(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "gamma-api.polymarket.com")
        return Response.json([
          {
            conditionId: id,
            outcomes: '["No","Yes"]',
            clobTokenIds: '["222","111"]',
          },
        ]);
      expect(u.pathname).toBe("/prices-history");
      expect(u.searchParams.get("interval")).toBe("1w");
      return Response.json({
        history: [
          { t: 100, p: u.searchParams.get("market") === "111" ? 0.6 : 0.38 },
        ],
      });
    });
    expect(await catalog.polymarketHistory(id, "1W")).toMatchObject({
      points: [{ time: 100, price: 0.6 }],
      noPoints: [{ time: 100, price: 0.38 }],
      basis: "token_price",
    });
    await expect(
      new PublicCatalog(async () =>
        Response.json([
          {
            conditionId: `0x${"d".repeat(64)}`,
            outcomes: '["No","Yes"]',
            clobTokenIds: '["222","111"]',
          },
        ]),
      ).polymarketHistory(id, "1W"),
    ).rejects.toThrow();
  });
  it("reads nested event markets and rejects a foreign event market", async () => {
    const catalog = new PublicCatalog(async () =>
      Response.json({
        event: { event_ticker: kalshi.event_ticker, markets: [kalshi] },
        markets: [],
      }),
    );
    const event = await catalog.eventMarkets(kalshi.event_ticker);
    expect(event.data.map((m) => m.id)).toEqual([kalshi.ticker]);
    expect(event.data[0]).toMatchObject({
      volume: 20,
      volumeUnit: "contracts",
    });
    const foreign = new PublicCatalog(async () =>
      Response.json({
        event: {
          event_ticker: kalshi.event_ticker,
          markets: [{ ...kalshi, event_ticker: "OTHER" }],
        },
      }),
    );
    await expect(foreign.eventMarkets(kalshi.event_ticker)).rejects.toThrow(
      "INVALID_PROVIDER_RESPONSE",
    );
  });
  it("accepts only final non-provisional binary settlement, never a closing price", async () => {
    const get = async (extra: Record<string, unknown>) =>
      (
        await new PublicCatalog(async (url) =>
          String(url).includes("/events/")
            ? Response.json({})
            : Response.json({ market: { ...kalshi, ...extra } }),
        ).get("kalshi", kalshi.ticker)
      ).data[0];
    const settled = {
      status: "finalized",
      market_type: "binary",
      result: "yes",
      settlement_ts: "2026-10-25T01:00:00Z",
      settlement_value_dollars: "1.0000",
      is_provisional: false,
    };
    expect((await get(settled))?.resolution).toEqual({
      outcome: "Yes",
      resolvedAt: settled.settlement_ts,
    });
    // Kalshi omits false is_provisional fields on normal markets.
    expect(
      (await get({ ...settled, is_provisional: undefined }))?.resolution
        ?.outcome,
    ).toBe("Yes");
    for (const extra of [
      { status: "closed" },
      { status: "determined" },
      { is_provisional: true },
      { market_type: "scalar" },
      { settlement_ts: null },
      { settlement_value_dollars: "0.5000" },
      { result: "scalar" },
    ])
      expect((await get({ ...settled, ...extra }))?.resolution).toBeNull();
    expect(
      (await get({ last_price_dollars: "1.0000" }))?.resolution,
    ).toBeNull();
  });
  it("fetches official Kalshi API without keys, preserves last trade and real rules", async () => {
    const client = new PublicCatalog(async (url, init) => {
      if (String(url).includes("/events/"))
        return Response.json({
          event: { event_ticker: kalshi.event_ticker, title: "A vs B" },
        });
      expect(String(url)).toContain(
        "https://external-api.kalshi.com/trade-api/v2/events?",
      );
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      return Response.json({
        events: [{ event_ticker: kalshi.event_ticker, markets: [kalshi] }],
        cursor: "native-cursor",
      });
    });
    const page = await client.list("kalshi", 20);
    expect(page.data[0]?.outcomes).toEqual([
      { name: "Yes", price: 0.42 },
      { name: "No", price: null },
    ]);
    expect(page.data[0]?.rules).toContain("No extra time");
    expect(page.data[0]?.eventTitle).toBe("A vs B");
    expect(page.data[0]?.eventId).toBe(kalshi.event_ticker);
    expect(page.provider).toBe("kalshi-public");
    await expect(
      client.list("polymarket", 20, page.nextCursor!),
    ).rejects.toThrow("CURSOR_FILTER_MISMATCH");
  });
  it("rejects mismatched event context without inventing a title", async () => {
    const page = await new PublicCatalog(async (url) =>
      String(url).includes("/events/")
        ? Response.json({
            event: { event_ticker: "OTHER", title: "Wrong match" },
          })
        : Response.json({ market: kalshi }),
    ).get("kalshi", kalshi.ticker);
    expect(page.data[0]?.eventTitle).toBeNull();
    expect(page.data[0]?.eventId).toBe(kalshi.event_ticker);
  });
  it("does not display untraded zeros as implied probability", async () => {
    const page = await new PublicCatalog(async () =>
      Response.json({
        events: [
          {
            event_ticker: kalshi.event_ticker,
            markets: [
              { ...kalshi, volume_fp: "0.00", last_price_dollars: "0.0000" },
            ],
          },
        ],
        cursor: "",
      }),
    ).list("kalshi", 20);
    expect(page.data[0]?.outcomes.every((o) => o.price === null)).toBe(true);
  });
  it("parses Polymarket arrays without inventing complementary prices", async () => {
    const page = await new PublicCatalog(async () =>
      Response.json([
        {
          id: "1",
          conditionId: `0x${"a".repeat(64)}`,
          question: "Will A win?",
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.61","0.38"]',
          description: "Official terms",
          endDate: null,
          updatedAt: null,
        },
      ]),
    ).list("polymarket", 20);
    expect(page.data[0]?.outcomes).toEqual([
      { name: "Yes", price: 0.61 },
      { name: "No", price: 0.38 },
    ]);
  });
  it("rejects malformed prices, wrong identity and provider errors without fixtures", async () => {
    await expect(
      new PublicCatalog(async () =>
        Response.json({
          events: [
            {
              event_ticker: kalshi.event_ticker,
              markets: [{ ...kalshi, last_price_dollars: "3.5" }],
            },
          ],
        }),
      ).list("kalshi", 20),
    ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
    await expect(
      new PublicCatalog(async () => Response.json({ market: kalshi })).get(
        "kalshi",
        "KXOTHER-26",
      ),
    ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
    await expect(
      new PublicCatalog(
        async () => new Response("secret", { status: 503 }),
      ).list("kalshi", 20),
    ).rejects.toThrow("PUBLIC_SOURCE_UNAVAILABLE");
  });
});
