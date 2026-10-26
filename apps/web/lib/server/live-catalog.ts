import "server-only";
import { z } from "zod";
import { PublicCatalog } from "../../../../packages/integrations/src/public-catalog";
import {
  CatalogError,
  TatumCatalog,
  marketReferenceSchema,
} from "../../../../packages/integrations/src/tatum/catalog";

export const liveQuerySchema = z
  .object({
    platform: z.enum(["polymarket", "kalshi"]),
    provider: z.enum(["auto", "public", "tatum"]).default("auto"),
    limit: z.coerce.number().int().min(1).max(40).default(20),
    cursor: z.string().max(6000).optional(),
    id: z.string().max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.id ||
      marketReferenceSchema.safeParse({
        platform: value.platform,
        id: value.id,
      }).success,
    "INVALID_MARKET_ID",
  );
type Query = z.infer<typeof liveQuerySchema>;
const cursorSchema = z
  .object({
    platform: z.enum(["polymarket", "kalshi"]),
    provider: z.enum(["tatum", "public"]),
    limit: z.number().int().min(1).max(40),
    native: z.union([
      z.string(),
      z.object({ value: z.string(), fingerprint: z.string() }).strict(),
    ]),
  })
  .strict();
const publicClient = new PublicCatalog();
const cache = new Map<string, { at: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();
let windowStart = 0;
let calls = 0;

export async function readLiveCatalog(input: Query) {
  const query = liveQuerySchema.parse(input);
  const provider =
    query.provider === "auto"
      ? process.env.TATUM_API_KEY?.trim()
        ? "tatum"
        : "public"
      : query.provider;
  let native: string | { value: string; fingerprint: string } | undefined;
  if (query.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.platform !== query.platform ||
        cursor.provider !== provider ||
        cursor.limit !== query.limit
      )
        throw new Error();
      native = cursor.native;
      if (
        provider === "public"
          ? typeof native !== "string"
          : typeof native === "string"
      )
        throw new Error();
    } catch {
      throw new CatalogError("CURSOR_FILTER_MISMATCH");
    }
  }
  const key = JSON.stringify([
    provider,
    query.platform,
    query.limit,
    query.id ?? null,
    query.cursor ?? null,
  ]);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < 30000) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (now - windowStart > 60000) {
    windowStart = now;
    calls = 0;
  }
  if (calls >= 40) throw new CatalogError("LOCAL_RATE_LIMITED", 60);
  calls++;
  const operation = async () => {
    if (provider === "public") {
      const client = publicClient;
      const result = query.id
        ? await client.get(query.platform, query.id)
        : await client.list(
            query.platform,
            query.limit,
            native as string | undefined,
          );
      // A bounded, explicitly labelled NBA selection precedes the general event feed.
      let featured = [] as typeof result.data;
      if(query.platform === "kalshi" && !query.id && !query.cursor) {
        try { featured = await client.featuredSports(); } catch { /* General catalog stays usable. */ }
      }
      const featuredIds=new Set(featured.map(m=>m.id));
      return {
        ...result,
        data: [...featured,...result.data.filter(m=>!featuredIds.has(m.id))],
        featuredSeries: featured.length ? "NBA match winners" : null,
        nextCursor: result.nextCursor
          ? Buffer.from(
              JSON.stringify({
                platform: query.platform,
                provider,
                limit: query.limit,
                native: result.nextCursor,
              }),
            ).toString("base64url")
          : null,
      };
    }
    const apiKey = process.env.TATUM_API_KEY;
    if (!apiKey?.trim()) throw new CatalogError("TATUM_NOT_CONFIGURED");
    const client = new TatumCatalog(apiKey);
    const result = query.id
      ? { ...(await client.get(query.platform, query.id)), nextCursor: null }
      : await client.list({
          platform: query.platform,
          limit: query.limit,
          ...(native
            ? { cursor: native as { value: string; fingerprint: string } }
            : {}),
        });
    const rows = Array.isArray(result.data) ? result.data : [result.data];
    const fetchedAt = rows[0]?.fetchedAt ?? new Date().toISOString();
    return {
      provider: "tatum",
      fetchedAt,
      data: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        question: row.question,
        eventId: row.eventId,
        eventTitle: null,
        outcomes: row.outcomes.map((o) => ({ name: o.name, price: o.price })),
        rules: row.rules,
        closeTime: row.closeTime,
        fetchedAt: row.fetchedAt,
        updatedAt: null,
        sourceUrl: row.source.url,
        priceBasis: "outcome_price",
      })),
      nextCursor: result.nextCursor
        ? Buffer.from(
            JSON.stringify({
              platform: query.platform,
              provider,
              limit: query.limit,
              native: result.nextCursor,
            }),
          ).toString("base64url")
        : null,
    };
  };
  const promise = operation()
    .then((value) => {
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
