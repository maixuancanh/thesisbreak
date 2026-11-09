import { describe, expect, it } from "vitest";
import {
  TatumCatalog,
  CatalogError,
  catalogQuerySchema,
  marketReferenceSchema,
} from "../../packages/integrations/src/tatum/catalog";

const id = `0x${"a".repeat(64)}`;
function market(platform = "polymarket") {
  return {
    id: platform === "polymarket" ? id : "KXDEMO-26",
    platform,
    eventId: "123",
    question: "Will the event happen?",
    description: null,
    category: "Sports",
    tags: [],
    imageUrl: null,
    status: "active",
    openTime: null,
    closeTime: null,
    settleTime: null,
    outcomes: [
      { name: "Yes", price: 0.6, tokenId: null },
      { name: "No", price: 0.4, tokenId: null },
    ],
    volume: 20,
    volumeUnit: platform === "kalshi" ? "contracts" : "usd",
    liquidity: null,
    resolution: null,
    createdAt: null,
    chain: null,
    source: {
      platform,
      platformId: platform === "polymarket" ? id : "KXDEMO-26",
      url: `https://${platform}.com/markets/demo`,
    },
  };
}
describe("Tatum adapter offline contract", () => {
  it("validates identity before service access and accepts timestamp offsets", () => {
    expect(
      marketReferenceSchema.safeParse({ platform: "polymarket", id: "harbor" })
        .success,
    ).toBe(false);
    expect(
      marketReferenceSchema.safeParse({ platform: "kalshi", id: "lowercase" })
        .success,
    ).toBe(false);
    expect(
      marketReferenceSchema.safeParse({ platform: "polymarket", id }).success,
    ).toBe(true);
    expect(
      catalogQuerySchema.safeParse({
        endingBefore: "2026-12-31T07:00:00+07:00",
      }).success,
    ).toBe(true);
  });
  it("rejects unsupported Kalshi filters before network access", () => {
    expect(
      catalogQuerySchema.safeParse({ platform: "kalshi", search: "team" })
        .success,
    ).toBe(false);
    expect(catalogQuerySchema.safeParse({ search: "team" }).success).toBe(
      false,
    );
    expect(
      catalogQuerySchema.safeParse({ platform: "polymarket", search: "team" })
        .success,
    ).toBe(true);
  });
  it("calls only the official endpoint with secret header and returns actual units", async () => {
    let observed: URL | undefined;
    const transport: typeof fetch = async (input, init) => {
      observed = new URL(String(input));
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-secret");
      expect(init?.redirect).toBe("error");
      return Response.json({
        data: [market("kalshi")],
        pagination: { pageSize: 1 },
      });
    };
    const result = await new TatumCatalog("test-secret", transport).list({
      platform: "kalshi",
      limit: 1,
    });
    expect(observed?.origin).toBe("https://api.tatum.io");
    expect(result.data[0]?.volumeUnit).toBe("contracts");
    expect(result.data[0]?.liquidity).toBeNull();
    expect(result.data[0]?.priceAsOf).toBeNull();
    expect(result.data[0]?.rules).toBeNull();
  });
  it("binds opaque cursors to the exact filter set", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return Response.json({
        data: [market()],
        pagination: { pageSize: 1, cursor: "opaque-token" },
      });
    };
    const client = new TatumCatalog("key", transport);
    const first = await client.list({ platform: "polymarket", limit: 1 });
    await client.list({
      platform: "polymarket",
      limit: 1,
      cursor: first.nextCursor!,
    });
    await expect(
      client.list({
        platform: "polymarket",
        search: "changed",
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow("CURSOR_FILTER_MISMATCH");
    expect(calls).toBe(2);
  });
  it("fails closed on wrong platform, source URL and malformed price", async () => {
    for (const row of [
      market("kalshi"),
      {
        ...market(),
        source: { ...market().source, url: "javascript:alert(1)" },
      },
      { ...market(), outcomes: [{ name: "Yes", price: 8, tokenId: null }] },
    ]) {
      const transport: typeof fetch = async () =>
        Response.json({ data: [row], pagination: { pageSize: 1 } });
      await expect(
        new TatumCatalog("key", transport).list({ platform: "polymarket" }),
      ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
    }
  });
  it("never substitutes empty data on provider failure or leaks the provider body", async () => {
    const transport: typeof fetch = async () =>
      new Response("private-key-body", {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    try {
      await new TatumCatalog("key", transport).list({});
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe("PROVIDER_RATE_LIMITED");
      expect((error as CatalogError).retryAfterSeconds).toBe(10);
      expect(String(error)).not.toContain("private-key-body");
    }
  });
  it("checks native ID shape and returned exact identity", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return Response.json({ data: market() });
    };
    const client = new TatumCatalog("key", transport);
    await expect(client.get("polymarket", "harbor")).rejects.toThrow(
      "INVALID_MARKET_ID",
    );
    expect(calls).toBe(0);
    expect((await client.get("polymarket", id)).data.id).toBe(id);
    await expect(
      client.get("polymarket", `0x${"b".repeat(64)}`),
    ).rejects.toThrow("INVALID_PROVIDER_RESPONSE");
  });
});
