import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLivePage,
  liveMarketPath,
  livePageSchema,
  outcomePrice,
} from "../../apps/web/lib/live-market";

const page = {
  data: [
    {
      id: "A/B",
      platform: "kalshi",
      question: "A question?",
      outcomes: [{ name: "Yes", price: null }],
      rules: null,
      closeTime: null,
      fetchedAt: "2026-10-22T00:00:00Z",
      updatedAt: null,
      sourceUrl: null,
    },
  ],
  nextCursor: null,
  provider: "kalshi-public",
  fetchedAt: "2026-10-22T00:00:00Z",
};
afterEach(() => vi.unstubAllGlobals());
describe("live market client contract", () => {
  it("keeps unknown prices distinct from a real zero and encodes native IDs", () => {
    expect(outcomePrice(null)).toBe("Price unavailable");
    expect(outcomePrice(0)).toBe("0¢");
    expect(liveMarketPath({ platform: "kalshi", id: "A/B" })).toBe(
      "/live-market/kalshi/A%2FB",
    );
    expect(livePageSchema.parse(page).data[0]?.outcomes[0]?.price).toBeNull();
  });
  it("rejects malformed prices and incorrect platform responses", async () => {
    expect(
      livePageSchema.safeParse({
        ...page,
        data: [{ ...page.data[0], outcomes: [{ name: "Yes", price: 45 }] }],
      }).success,
    ).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(page))),
    );
    await expect(
      fetchLivePage(
        new URLSearchParams({ platform: "polymarket" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("different platform");
  });
  it("preserves the resolved source in detail links", () => {
    const market = { platform: "kalshi" as const, id: "A/B" };
    expect(liveMarketPath(market, "kalshi-public")).toBe(
      "/live-market/kalshi/A%2FB?provider=public",
    );
    expect(liveMarketPath(market, "tatum")).toBe(
      "/live-market/kalshi/A%2FB?provider=tatum",
    );
  });
  it("rejects a different native market ID in a detail response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(page))),
    );
    await expect(
      fetchLivePage(
        new URLSearchParams({
          platform: "kalshi",
          id: "another-market",
          provider: "public",
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("different market");
  });
  it("passes abort signal and refuses error responses without fixtures", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(
      fetchLivePage(new URLSearchParams({ platform: "kalshi" }), signal),
    ).rejects.toThrow("unavailable or unconfigured");
    expect(fetcher).toHaveBeenCalledWith("/api/live-markets?platform=kalshi", {
      signal,
      cache: "no-store",
    });
  });
});
