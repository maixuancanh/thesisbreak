import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("../../apps/web/node_modules/server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  publicGet: vi.fn(),
  reserve: vi.fn(async () => {}),
}));
vi.mock("../../packages/db/src/provider-budget", () => ({
  reserveProviderCredits: mocks.reserve,
  blockProvider: vi.fn(),
}));
vi.mock(
  "../../packages/integrations/src/tatum/catalog",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../packages/integrations/src/tatum/catalog")
      >();
    return {
      ...original,
      TatumCatalog: class {
        async get() {
          return mocks.get();
        }
      },
    };
  },
);
vi.mock("../../packages/integrations/src/public-catalog", () => ({
  PublicCatalog: class {
    async get() {
      return mocks.publicGet();
    }
  },
}));
vi.mock("../../packages/db/src/provider-cache", () => ({
  providerCacheKey: () => "test-cache-key",
  cachedPublicProviderRead: async (
    _pool: unknown,
    _provider: unknown,
    _key: unknown,
    _ttl: unknown,
    load: () => Promise<unknown>,
  ) => load(),
}));
import { readLiveCatalog } from "../../apps/web/lib/server/live-catalog";
import { livePageSchema } from "../../apps/web/lib/live-market";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("catalog readiness and metadata", () => {
  it("a key alone keeps automatic discovery on public data", async () => {
    vi.stubEnv("TATUM_API_KEY", "test-key");
    vi.stubEnv("TATUM_MARKETS_ENABLED", "");
    mocks.publicGet.mockResolvedValue({
      data: [],
      provider: "kalshi-public",
      fetchedAt: "2026-10-27T00:00:00Z",
      nextCursor: null,
    });
    const result = livePageSchema.parse(
      await readLiveCatalog({
        platform: "kalshi",
        provider: "auto",
        id: "KEYONLY",
        limit: 20,
      }),
    );
    expect(result.provider).toBe("kalshi-public");
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("rejects explicit Tatum requests while disabled", async () => {
    vi.stubEnv("TATUM_MARKETS_ENABLED", "");
    await expect(
      readLiveCatalog({
        platform: "kalshi",
        provider: "tatum",
        id: "DISABLED",
        limit: 20,
      }),
    ).rejects.toThrow("TATUM_MARKETS_DISABLED");
  });
  it("preserves provider metadata through the browser boundary without inferring resolution", async () => {
    vi.stubEnv("TATUM_MARKETS_ENABLED", "true");
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
    vi.stubEnv("TATUM_API_KEY", "test-key");
    const row = {
      id: "METADATA",
      platform: "kalshi",
      question: "Test?",
      eventId: "EVENT",
      category: "sports",
      status: "closed",
      tags: ["nba"],
      imageUrl: "https://example.com/image.png",
      description: "rules",
      openTime: "2026-10-26T00:00:00Z",
      closeTime: "2026-10-27T00:00:00Z",
      settleTime: null,
      createdAt: null,
      volume: 12,
      volumeUnit: "contracts",
      liquidity: null,
      resolution: null,
      priceAsOf: null,
      coverage: "market_data_only",
      outcomes: [
        { name: "Yes", price: 0.6 },
        { name: "No", price: 0.4 },
      ],
      rules: "rules",
      source: { url: "https://kalshi.com/markets/test" },
      fetchedAt: "2026-10-27T00:00:00Z",
    };
    mocks.get.mockResolvedValue({ data: row });
    const result = livePageSchema.parse(
      await readLiveCatalog({
        platform: "kalshi",
        provider: "tatum",
        id: "METADATA",
        limit: 20,
      }),
    );
    expect(result.data[0]).toMatchObject({
      category: "sports",
      status: "closed",
      volumeUnit: "contracts",
      volume: 12,
      tags: ["nba"],
      imageUrl: row.imageUrl,
      resolution: null,
      coverage: "market_data_only",
      priceAsOf: null,
    });
  });
});
