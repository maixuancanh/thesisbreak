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
