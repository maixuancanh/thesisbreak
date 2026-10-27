import "server-only";
import { z } from "zod";
import type { Pool } from "pg";
import {
  TatumResearch,
  historyQuerySchema,
  eventsQuerySchema,
  searchQuerySchema,
} from "../../../../packages/integrations/src/tatum/research";
import {
  CatalogError,
  marketReferenceSchema,
} from "../../../../packages/integrations/src/tatum/catalog";
import {
  reserveProviderCredits,
  blockProvider,
} from "../../../../packages/db/src/provider-budget";
import {
  cachedPublicProviderRead,
  providerCacheKey,
} from "../../../../packages/db/src/provider-cache";
import type { ResearchSource } from "../../../../packages/agent/src/runtime";
type Environment = Readonly<Record<string, string | undefined>>;
const operation = z.enum(["quote", "history", "events", "search"]);
export const tatumOperationSchema = z
  .object({ operation })
  .passthrough()
  .transform((raw, ctx) => {
    const { operation: op, ...query } = raw;
    for (const field of ["limit", "page", "limitPerType"])
      if (typeof query[field] === "string") query[field] = Number(query[field]);
    if (query.includeMarkets !== undefined) {
      if (
        !["true", "false", true, false].includes(
          query.includeMarkets as string | boolean,
        )
      ) {
        ctx.addIssue({ code: "custom", message: "INVALID_BOOLEAN" });
        return z.NEVER;
      }
      query.includeMarkets =
        query.includeMarkets === true || query.includeMarkets === "true";
    }
    const schema =
      op === "quote"
        ? marketReferenceSchema
        : op === "history"
          ? historyQuerySchema
          : op === "events"
            ? eventsQuerySchema
            : searchQuerySchema;
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: issue.path });
      return z.NEVER;
    }
    return { operation: op, query: parsed.data };
  });
function configured(env: Environment) {
  if (env.TATUM_RESEARCH_ENABLED !== "true" || !env.TATUM_API_KEY?.trim())
    throw new CatalogError("TATUM_RESEARCH_DISABLED");
  return env.TATUM_API_KEY;
}
export async function readTatumOperation(
  pool: Pool,
  input: unknown,
  env: Environment = process.env,
  signal?: AbortSignal,
) {
  const key = configured(env);
  const parsed = tatumOperationSchema.parse(input);
  signal?.throwIfAborted();
  const client = new TatumResearch(key, fetch, async (cost) => {
    signal?.throwIfAborted();
    await reserveProviderCredits(
      pool,
      "tatum",
      cost,
      Number(env.TATUM_DAILY_CREDIT_LIMIT ?? "0"),
    );
  });
  const cacheKey = providerCacheKey(parsed.operation, parsed.query);
  try {
    return await cachedPublicProviderRead(
      pool,
      "tatum",
      cacheKey,
      parsed.operation === "quote"
        ? 30
        : parsed.operation === "history"
          ? 300
          : 60,
      async () => {
        signal?.throwIfAborted();
        switch (parsed.operation) {
          case "quote":
            return client.quote(marketReferenceSchema.parse(parsed.query));
          case "history":
            return client.history(historyQuerySchema.parse(parsed.query));
          case "events":
            return client.events(eventsQuerySchema.parse(parsed.query));
          case "search":
            return client.search(searchQuerySchema.parse(parsed.query));
        }
      },
    );
  } catch (error) {
    if (error instanceof CatalogError && error.code === "PROVIDER_RATE_LIMITED")
      await blockProvider(pool, "tatum", error.retryAfterSeconds ?? 60);
    throw error;
  }
}
export function createTatumReaders(
  pool: Pool,
  market: {
    platform: "kalshi" | "polymarket";
    nativeId: string;
    sourceUrl?: string | null;
    signal?: AbortSignal;
  },
  env: Environment = process.env,
) {
  const read = async (kind: "quote" | "history"): Promise<ResearchSource[]> => {
    // Rounded hourly bounds give separate workers the same public history cache key.
    const end = new Date(Math.floor(Date.now() / 3600000) * 3600000);
    const input =
      kind === "quote"
        ? { operation: kind, platform: market.platform, id: market.nativeId }
        : {
            operation: kind,
            platform: market.platform,
            id: market.nativeId,
            interval: "1h",
            source: "candlesticks",
            start: new Date(end.getTime() - 7 * 86400000).toISOString(),
            end: end.toISOString(),
          };
    const result = await readTatumOperation(pool, input, env, market.signal);
    const observation = z
      .object({
        data: z.unknown(),
        fetchedAt: z.string(),
        provider: z.literal("tatum"),
      })
      .passthrough()
      .parse(result);
    const raw = observation.data;
    const data =
      kind === "history" &&
      raw &&
      typeof raw === "object" &&
      "candles" in raw &&
      Array.isArray(raw.candles)
        ? {
            ...raw,
            candles: raw.candles.slice(-48),
            contextNote:
              "Latest 48 hourly candles of requested seven-day range; omitted earlier candles are not absence of trading.",
          }
        : raw;
    return [
      {
        id: `tatum-${kind}`,
        url: `https://api.tatum.io/v4/data/prediction/markets/${encodeURIComponent(market.nativeId)}/${kind === "quote" ? "price" : "history"}`,
        retrievedAt: observation.fetchedAt,
        kind: "background",
        text: JSON.stringify({
          ...observation,
          data,
          note: "Read-only provider observations; cached fetchedAt is preserved. Prices/history do not establish final settlement or reasoning quality.",
        }),
      },
    ];
  };
  return {
    readTatumQuote: () => read("quote"),
    readTatumHistory: () => read("history"),
  };
}
