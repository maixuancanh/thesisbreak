import { describe, it, expect, vi } from "vitest";
import {
  providerCacheKey,
  cachedPublicProviderRead,
  writeProviderCache,
} from "../../packages/db/src/provider-cache";
import type { Pool } from "pg";
describe("public provider cache bounds", () => {
  it("normalizes exact query field order while separating operations and platforms", () => {
    expect(providerCacheKey("quote", { id: "A", platform: "kalshi" })).toBe(
      providerCacheKey("quote", { platform: "kalshi", id: "A" }),
    );
    expect(providerCacheKey("quote", { id: "A" })).not.toBe(
      providerCacheKey("history", { id: "A" }),
    );
  });
  it("cached data avoids a provider request", async () => {
    const load = vi.fn();
    const query = vi.fn(async () => ({
      rows: [{ payload: { fetchedAt: "original" } }],
    }));
    expect(
      await cachedPublicProviderRead(
        { query } as unknown as Pool,
        "tatum",
        "key",
        30,
        load,
      ),
    ).toEqual({ fetchedAt: "original" });
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects excessive retention before SQL writes", async () => {
    const query = vi.fn();
    await expect(
      writeProviderCache(
        { query } as unknown as Pool,
        "tatum",
        "key",
        {},
        7200,
      ),
    ).rejects.toThrow("INVALID_CACHE_TTL");
    expect(query).not.toHaveBeenCalled();
  });
});
