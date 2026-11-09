import { createHash } from "node:crypto";
import type { Pool } from "pg";
/** Versioned exact public query keys only. Callers must never pass account records or credentials. */
export function providerCacheKey(
  operation: string,
  query: Readonly<Record<string, unknown>>,
) {
  const normalized = Object.fromEntries(
    Object.entries(query).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(JSON.stringify(["public-provider-v1", operation, normalized]))
    .digest("hex");
}
export async function readProviderCache<T>(
  pool: Pool,
  provider: string,
  key: string,
): Promise<T | null> {
  const result = await pool.query(
    "SELECT payload FROM provider_public_cache WHERE provider=$1 AND query_key=$2 AND expires_at>NOW()",
    [provider, key],
  );
  return (result.rows[0]?.payload as T | undefined) ?? null;
}
export async function writeProviderCache(
  pool: Pool,
  provider: string,
  key: string,
  payload: unknown,
  ttlSeconds: number,
) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)
    throw new Error("INVALID_CACHE_TTL");
  const serialized = JSON.stringify(payload);
  if (serialized.length > 2000000) throw new Error("CACHE_PAYLOAD_TOO_LARGE");
  await pool.query(
    `INSERT INTO provider_public_cache(provider,query_key,payload,expires_at) VALUES($1,$2,$3::jsonb,NOW()+$4*INTERVAL '1 second') ON CONFLICT(provider,query_key) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`,
    [provider, key, serialized, ttlSeconds],
  );
}
/** No transaction is held over HTTP. Concurrent misses remain covered by durable credits. */
export async function cachedPublicProviderRead<T>(
  pool: Pool,
  provider: string,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cached = await readProviderCache<T>(pool, provider, key);
  if (cached !== null) return cached;
  const value = await load();
  await writeProviderCache(pool, provider, key, value, ttlSeconds);
  return value;
}
