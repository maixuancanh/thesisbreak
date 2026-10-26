import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogError } from "../../packages/integrations/src/tatum/catalog";
const offline = vi.hoisted(() => ({ calls: 0, failure: null as Error | null }));
vi.mock("../../apps/web/lib/server/catalog-service", () => ({
  catalogOperation: async () => {
    offline.calls++;
    if (offline.failure) throw offline.failure;
    return { data: [] };
  },
}));
import { GET } from "../../apps/web/app/api/markets/route";

describe("catalog route validation with offline service", () => {
  beforeEach(() => {
    offline.calls = 0;
    offline.failure = null;
  });
  it("rejects invalid identities and unsupported filters before service or quota access", async () => {
    for (const query of [
      "platform=polymarket&id=harbor",
      "platform=kalshi&search=team",
      "limit=1&limit=2",
      "cursor=invalid-json",
    ]) {
      const response = await GET(
        new Request(`https://example.test/api/markets?${query}`),
      );
      expect(response.status).toBe(400);
    }
    expect(offline.calls).toBe(0);
  });
  it("returns configuration failure honestly and never turns it into an empty catalog", async () => {
    offline.failure = new CatalogError("TATUM_NOT_CONFIGURED");
    const response = await GET(
      new Request("https://example.test/api/markets?platform=polymarket"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "TATUM_NOT_CONFIGURED" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("preserves retry timing without forwarding provider content", async () => {
    offline.failure = new CatalogError("PROVIDER_RATE_LIMITED", 10);
    const response = await GET(new Request("https://example.test/api/markets"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("10");
    offline.failure = new Error("secret-provider-body");
    const unexpected = await GET(
      new Request("https://example.test/api/markets"),
    );
    expect(await unexpected.text()).not.toContain("secret-provider-body");
  });
});
