import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll, vi } from "vitest";
import {
  providerCacheKey,
  readProviderCache,
  writeProviderCache,
  cachedPublicProviderRead,
} from "../../packages/db/src/provider-cache";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("persistent public provider cache", () => {
  const first = new Pool({ connectionString: url }),
    second = new Pool({ connectionString: url });
  const provider = `test-cache-${randomUUID()}`;
  afterAll(async () => {
    await first.query("DELETE FROM provider_public_cache WHERE provider=$1", [
      provider,
    ]);
    await Promise.all([first.end(), second.end()]);
  });
  it("shares exact public-query results across connections and preserves original fetchedAt", async () => {
    const key = providerCacheKey("quote", { platform: "kalshi", id: "TEST" });
    const value = { data: { price: 0.5 }, fetchedAt: "2026-10-27T00:00:00Z" };
    await writeProviderCache(first, provider, key, value, 30);
    const load = vi.fn(async () => ({
      data: { price: 0.7 },
      fetchedAt: "later",
    }));
    expect(
      await cachedPublicProviderRead(second, provider, key, 30, load),
    ).toEqual(value);
    expect(load).not.toHaveBeenCalled();
    expect(await readProviderCache(second, "other-provider", key)).toBeNull();
    expect(
      await readProviderCache(
        second,
        provider,
        providerCacheKey("quote", { platform: "kalshi", id: "OTHER" }),
      ),
    ).toBeNull();
  });
  it("reloads expired entries without holding a transaction over the loader", async () => {
    const key = providerCacheKey("quote", { id: "EXPIRED" });
    await writeProviderCache(first, provider, key, { old: true }, 30);
    await first.query(
      "UPDATE provider_public_cache SET expires_at=NOW()-INTERVAL '1 second' WHERE provider=$1 AND query_key=$2",
      [provider, key],
    );
    const load = vi.fn(async () => ({ fresh: true }));
    expect(
      await cachedPublicProviderRead(second, provider, key, 30, load),
    ).toEqual({ fresh: true });
    expect(load).toHaveBeenCalledOnce();
    expect(await readProviderCache(first, provider, key)).toEqual({
      fresh: true,
    });
  });
});
