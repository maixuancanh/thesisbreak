import { z } from "zod";
import { CatalogError, marketReferenceSchema, rowSchema } from "./catalog";
const platform = z.enum(["polymarket", "kalshi"]);
const date = z.iso.datetime({ offset: true });
const probability = z.number().finite().min(0).max(1);
const nullablePrice = probability.nullish().transform((v) => v ?? null);
const quantity = z.number().finite().nonnegative();
const side = z.object({
  price: probability,
  bid: nullablePrice,
  ask: nullablePrice,
  bidSize: quantity.nullable(),
  askSize: quantity.nullable(),
});
const quoteSchema = z.object({
  marketId: z.string(),
  platform,
  timestamp: date,
  yes: side,
  no: side,
  midPrice: nullablePrice,
  spread: nullablePrice,
  lastTradePrice: nullablePrice,
  lastTradeAt: date.nullable(),
  volume24h: quantity.nullable(),
  volumeUnit: z.enum(["usd", "contracts"]).nullable(),
});
const interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]);
const historySource = z.enum(["candlesticks", "midpoint"]);
const historySchema = z.object({
  marketId: z.string(),
  platform,
  interval,
  source: historySource,
  candles: z
    .array(
      z.object({
        timestamp: date,
        open: probability,
        high: probability,
        low: probability,
        close: probability,
        volume: quantity,
      }),
    )
    .max(2000),
  partial: z.boolean(),
  availableFrom: date.nullable(),
});
export const historyQuerySchema = marketReferenceSchema
  .safeExtend({
    interval,
    start: date,
    end: date,
    source: historySource.default("candlesticks"),
  })
  .superRefine((q, ctx) => {
    // Conservative application limits, not a claim of exact provider range caps.
    const days = {
      "1m": 1,
      "5m": 5,
      "15m": 15,
      "1h": 60,
      "4h": 180,
      "1d": 365,
      "1w": 730,
    }[q.interval];
    const span = Date.parse(q.end) - Date.parse(q.start);
    if (span <= 0 || span > days * 86400000)
      ctx.addIssue({ code: "custom", message: "HISTORY_RANGE_EXCEEDED" });
    if (q.source === "midpoint" && q.platform !== "polymarket")
      ctx.addIssue({ code: "custom", message: "POLYMARKET_ONLY_CAPABILITY" });
  });
const nestedMarket = rowSchema.omit({ chain: true });
const eventSchema = z.object({
  id: z.string().min(1).max(128),
  platform,
  title: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()).max(100),
  imageUrl: z.string().nullable(),
  status: z.string(),
  openTime: date.nullable(),
  closeTime: date.nullable(),
  marketCount: z.number().int().nonnegative(),
  totalVolume: quantity,
  volumeUnit: z.enum(["usd", "contracts"]),
  totalLiquidity: quantity.nullable(),
  markets: z
    .array(z.union([z.string().max(128), nestedMarket]))
    .max(1000)
    .nullable(),
  source: z.object({ platform, platformId: z.string(), url: z.url() }),
});
export const eventsQuerySchema = z
  .object({
    platform: platform.optional(),
    status: z.enum(["active", "closed", "resolved"]).optional(),
    category: z.string().min(1).max(64).optional(),
    tag: z.string().min(1).max(64).optional(),
    search: z.string().min(1).max(256).optional(),
    sort: z
      .enum(["volume_desc", "liquidity_desc", "endingSoon", "newest"])
      .optional(),
    limit: z.number().int().min(1).max(40).default(20),
    cursor: z.string().min(1).max(1024).optional(),
    includeMarkets: z.boolean().default(false),
  })
  .strict()
  .refine(
    (q) =>
      q.platform === "polymarket" ||
      [q.status, q.category, q.tag, q.search].every((v) => v === undefined),
    "POLYMARKET_FILTER_REQUIRED",
  );
export const searchQuerySchema = z
  .object({
    platform: z.literal("polymarket"),
    q: z.string().trim().min(2).max(128),
    page: z.number().int().min(1).max(1000).default(1),
    limitPerType: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const pagination = z.object({
  pageSize: z.number().int().min(1).max(100),
  cursor: z.string().max(1024).optional(),
});
export type TatumQuote = z.infer<typeof quoteSchema>;
export type TatumHistory = z.infer<typeof historySchema>;
export type TatumEvent = z.infer<typeof eventSchema>;
export type TatumHistoryQuery = z.input<typeof historyQuerySchema>;
export type TatumEventsQuery = z.input<typeof eventsQuerySchema>;
export type TatumSearchQuery = z.input<typeof searchQuerySchema>;
export type BeforeTatumRequest = (costCredits: number) => Promise<void>;
function validEvent(event: TatumEvent) {
  const url = new URL(event.source.url);
  const ids = event.platform === "polymarket" ? /^\d+$/ : /^[A-Z][A-Z0-9_.-]*$/;
  if (
    !ids.test(event.id) ||
    event.source.platform !== event.platform ||
    url.protocol !== "https:" ||
    ![
      "polymarket.com",
      "www.polymarket.com",
      "kalshi.com",
      "www.kalshi.com",
    ].includes(url.hostname) ||
    !url.hostname.endsWith(event.platform + ".com") ||
    url.username ||
    url.password ||
    url.port ||
    event.volumeUnit !== (event.platform === "kalshi" ? "contracts" : "usd")
  )
    throw new CatalogError("INVALID_PROVIDER_RESPONSE");
  for (const market of event.markets ?? []) {
    const id = typeof market === "string" ? market : market.id;
    if (
      !marketReferenceSchema.safeParse({ platform: event.platform, id })
        .success ||
      (typeof market !== "string" && market.platform !== event.platform)
    )
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
  }
  return event;
}
/** Bounded read-only REST contracts inspected in official docs OpenAPI; not live-schema acceptance. */
export class TatumResearch {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly beforeRequest?: BeforeTatumRequest,
  ) {
    if (typeof window !== "undefined") throw new CatalogError("SERVER_ONLY");
    if (!apiKey.trim()) throw new CatalogError("TATUM_NOT_CONFIGURED");
  }
  private async request(
    path: string,
    cost: number,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL("https://api.tatum.io/v4/data/prediction/" + path);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    await this.beforeRequest?.(cost);
    try {
      const response = await this.transport(url, {
        headers: { "x-api-key": this.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      if (!response.ok) {
        const retry = Number(response.headers.get("Retry-After"));
        throw new CatalogError(
          response.status === 429
            ? "PROVIDER_RATE_LIMITED"
            : response.status === 401 || response.status === 403
              ? "PROVIDER_ACCESS_DENIED"
              : response.status === 404
                ? "MARKET_NOT_FOUND"
                : response.status === 400
                  ? "PROVIDER_CAPABILITY_REJECTED"
                  : "PROVIDER_UNAVAILABLE",
          response.status === 429 && retry > 0 && Number.isFinite(retry)
            ? Math.min(retry, 3600)
            : undefined,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2000000) {
            await reader.cancel();
            throw new CatalogError("INVALID_PROVIDER_RESPONSE");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("PROVIDER_UNAVAILABLE");
    }
  }
  private parse<T>(schema: z.ZodType<T>, payload: unknown) {
    const result = schema.safeParse(payload);
    if (!result.success) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return result.data;
  }
  async quote(input: z.input<typeof marketReferenceSchema>) {
    const q = marketReferenceSchema.parse(input);
    const { data } = this.parse(
      z.object({ data: quoteSchema }),
      await this.request(`markets/${encodeURIComponent(q.id)}/price`, 100),
    );
    if (
      data.marketId !== q.id ||
      data.platform !== q.platform ||
      (data.volumeUnit !== null &&
        data.volumeUnit !== (q.platform === "kalshi" ? "contracts" : "usd"))
    )
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return {
      data,
      provider: "tatum" as const,
      fetchedAt: new Date().toISOString(),
      priceUnit: "probability_0_1" as const,
    };
  }
  async history(input: TatumHistoryQuery) {
    const { platform, id, ...query } = historyQuerySchema.parse(input);
    const { data } = this.parse(
      z.object({ data: historySchema }),
      await this.request(
        `markets/${encodeURIComponent(id)}/history`,
        200,
        query,
      ),
    );
    const width = {
      "1m": 60000,
      "5m": 300000,
      "15m": 900000,
      "1h": 3600000,
      "4h": 14400000,
      "1d": 86400000,
      "1w": 604800000,
    }[query.interval];
    const before = data.candles.filter(
      (c) => Date.parse(c.timestamp) < Date.parse(query.start),
    );
    if (
      data.marketId !== id ||
      data.platform !== platform ||
      data.interval !== query.interval ||
      data.source !== query.source ||
      data.candles.some(
        (c) =>
          (data.source === "candlesticks"
            ? Date.parse(c.timestamp) <= Date.parse(query.start) - width
            : Date.parse(c.timestamp) < Date.parse(query.start)) ||
          Date.parse(c.timestamp) > Date.parse(query.end) ||
          (data.source === "midpoint" && c.volume !== 0),
      ) ||
      before.length > 1 ||
      new Set(data.candles.map((c) => c.timestamp)).size !== data.candles.length
    )
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return {
      // Live Polymarket responses include the bucket overlapping start. Exclude
      // that bucket, preserve the requested range and disclose partial coverage.
      data: {
        ...data,
        candles: data.candles.filter(
          (c) => Date.parse(c.timestamp) >= Date.parse(query.start),
        ),
        partial: data.partial || before.length > 0,
      },
      provider: "tatum" as const,
      fetchedAt: new Date().toISOString(),
      priceUnit: "probability_0_1" as const,
      volumeUnit:
        platform === "kalshi" ? ("contracts" as const) : ("usd" as const),
    };
  }
  async events(input: TatumEventsQuery) {
    const query = eventsQuerySchema.parse(input);
    const result = this.parse(
      z.object({ data: z.array(eventSchema).max(40), pagination }),
      await this.request("events", 100, query),
    );
    for (const event of result.data) {
      validEvent(event);
      if (query.platform && event.platform !== query.platform)
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    }
    return {
      ...result,
      provider: "tatum" as const,
      fetchedAt: new Date().toISOString(),
    };
  }
  async search(input: TatumSearchQuery) {
    const { platform: _, ...query } = searchQuerySchema.parse(input);
    void _;
    const result = this.parse(
      z.object({
        data: z.object({
          events: z.array(eventSchema).max(20),
          tags: z
            .array(
              z.object({
                id: z.string().nullable(),
                slug: z.string().nullable(),
                label: z.string().nullable(),
                eventCount: z.number().int().nonnegative(),
              }),
            )
            .max(20),
          profiles: z
            .array(
              z.object({
                proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
                name: z.string().nullable(),
                pseudonym: z.string().nullable(),
              }),
            )
            .max(20),
          pagination: z.object({
            hasMore: z.boolean(),
            totalResults: z.number().int().nonnegative(),
          }),
        }),
      }),
      await this.request("search", 50, { ...query, searchProfiles: false }),
    );
    for (const event of result.data.events) {
      validEvent(event);
      if (event.platform !== "polymarket")
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    }
    return {
      ...result,
      provider: "tatum" as const,
      fetchedAt: new Date().toISOString(),
    };
  }
}
