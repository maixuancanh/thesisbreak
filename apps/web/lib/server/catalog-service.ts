import "server-only";
import {
  TatumCatalog,
  CatalogError,
  type CatalogQuery,
  type Platform,
  marketReferenceSchema,
  catalogQuerySchema,
} from "../../../../packages/integrations/src/tatum/catalog";

// One process only: coalesce bursts and cap upstream spend. Distributed deployments
// need shared quota/cache before opening unrestricted public access.
const cache = new Map<string, { at: number; value: unknown }>();
const running = new Map<string, Promise<unknown>>();
let budget = { since: 0, requests: 0 };
export async function catalogOperation(
  query: CatalogQuery | { platform: Platform; id: string },
) {
  query =
    "id" in query
      ? marketReferenceSchema.parse(query)
      : catalogQuerySchema.parse(query);
  const key = process.env.TATUM_API_KEY;
  if (!key?.trim()) throw new CatalogError("TATUM_NOT_CONFIGURED");
  const operation = "id" in query ? "detail" : "list";
  const cacheKey = JSON.stringify([
    operation,
    Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  const now = Date.now();
  const saved = cache.get(cacheKey);
  if (saved && now - saved.at < 30_000) return saved.value;
  const pending = running.get(cacheKey);
  if (pending) return pending;
  if (now - budget.since > 60_000) budget = { since: now, requests: 0 };
  if (budget.requests >= 30) throw new CatalogError("LOCAL_RATE_LIMITED", 60);
  budget.requests++;
  const client = new TatumCatalog(key);
  const promise = (
    "id" in query ? client.get(query.platform, query.id) : client.list(query)
  )
    .then((value) => {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    })
    .finally(() => running.delete(cacheKey));
  running.set(cacheKey, promise);
  return promise;
}
