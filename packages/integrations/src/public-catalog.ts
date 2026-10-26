import { z } from "zod";
import {
  marketPresentation,
  trustedMarketImage,
  eventSchema,
  eventArtworkSchema,
  type Presentation,
  type EventPresentation,
} from "./public-metadata";
import {
  CatalogError,
  marketReferenceSchema,
  type Platform,
} from "./tatum/catalog";

const time = z.iso.datetime({ offset: true }).nullish();
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number)
  .refine(Number.isFinite);
const price = decimal.refine((v) => v >= 0 && v <= 1);
const kalshiSchema = z.object({
  ticker: z.string().min(1),
  title: z.string().min(1),
  event_ticker: z.string(),
  last_price_dollars: price,
  volume_fp: decimal,
  close_time: time,
  updated_time: time,
  rules_primary: z.string().optional(),
  rules_secondary: z.string().optional(),
});
// Only finalized binary settlements count. Provisional markets may be removed;
// Kalshi omits this false flag on ordinary markets (official OpenAPI x-omitempty).
const finalBinarySettlement = z
  .object({
    status: z.literal("finalized"),
    market_type: z.literal("binary"),
    result: z.enum(["yes", "no"]),
    settlement_ts: z.iso.datetime({ offset: true }),
    settlement_value_dollars: price,
    is_provisional: z.literal(false).optional(),
  })
  .refine((r) => r.settlement_value_dollars === (r.result === "yes" ? 1 : 0));
const arrayField = z.union([
  z.string().transform((value, ctx): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_ARRAY" });
      return z.NEVER;
    }
  }),
  z.array(z.unknown()),
]);
const polySchema = z.object({
  id: z.string().regex(/^\d+$/),
  conditionId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  question: z.string().min(1),
  outcomes: arrayField.pipe(z.array(z.string().min(1)).min(2)),
  outcomePrices: arrayField.pipe(
    z.array(z.union([price, z.number().min(0).max(1)])),
  ),
  description: z.string().nullish(),
  endDate: time,
  updatedAt: time,
});
export type PublicMarket = Presentation & {
  resolution?: { outcome: string; resolvedAt: string } | null;
  id: string;
  platform: Platform;
  question: string;
  eventId: string | null;
  eventTitle: string | null;
  outcomes: { name: string; price: number | null }[];
  rules: string | null;
  closeTime: string | null;
  fetchedAt: string;
  updatedAt: string | null;
  sourceUrl: string | null;
  priceBasis: "last_trade" | "outcome_price" | "unavailable";
};
const cursorSchema = z
  .object({
    platform: z.enum(["polymarket", "kalshi"]),
    limit: z.number().int().min(1).max(40),
    native: z.string().max(2048),
    offset: z.number().int().nonnegative().max(10000),
  })
  .strict();
export class PublicCatalog {
  private readonly events = new Map<
    string,
    { at: number; value: EventPresentation }
  >();
  constructor(private readonly transport: typeof fetch = fetch) {
    if (typeof window !== "undefined") throw new CatalogError("SERVER_ONLY");
  }
  private async read(url: URL): Promise<unknown> {
    try {
      const response = await this.transport(url, {
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      });
      if (!response.ok)
        throw new CatalogError(
          response.status === 404
            ? "MARKET_NOT_FOUND"
            : response.status === 429
              ? "PROVIDER_RATE_LIMITED"
              : "PUBLIC_SOURCE_UNAVAILABLE",
        );
      const reader = response.body?.getReader();
      if (!reader) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) {
            await reader.cancel();
            throw new CatalogError("INVALID_PROVIDER_RESPONSE");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      }
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("PUBLIC_SOURCE_UNAVAILABLE");
    }
  }
  private normalize(
    value: unknown,
    platform: Platform,
    fetchedAt: string,
  ): PublicMarket {
    try {
      if (platform === "kalshi") {
        const row = kalshiSchema.parse(value);
        const final = finalBinarySettlement.safeParse(value);
        marketReferenceSchema.parse({ platform, id: row.ticker });
        const traded = row.volume_fp > 0;
        return {
          ...marketPresentation(value, platform),
          id: row.ticker,
          resolution:
            final.success &&
            Date.parse(final.data.settlement_ts) <= Date.parse(fetchedAt)
              ? {
                  outcome: final.data.result === "yes" ? "Yes" : "No",
                  resolvedAt: final.data.settlement_ts,
                }
              : null,
          platform,
          question: row.title,
          eventId: row.event_ticker,
          eventTitle: null,
          outcomes: [
            { name: "Yes", price: traded ? row.last_price_dollars : null },
            { name: "No", price: null },
          ],
          rules:
            [row.rules_primary, row.rules_secondary]
              .filter(Boolean)
              .join("\n\n") || null,
          closeTime: row.close_time ?? null,
          updatedAt: row.updated_time ?? null,
          fetchedAt,
          sourceUrl: `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(row.ticker)}`,
          priceBasis: traded ? "last_trade" : "unavailable",
        };
      }
      const row = polySchema.parse(value);
      if (
        row.outcomes.length !== row.outcomePrices.length ||
        new Set(row.outcomes).size !== row.outcomes.length
      )
        throw new Error("OUTCOMES_MISMATCH");
      return {
        ...marketPresentation(value, platform),
        id: row.conditionId,
        platform,
        question: row.question,

        outcomes: row.outcomes.map((name, i) => ({
          name,
          price: row.outcomePrices[i]!,
        })),
        rules: row.description ?? null,
        closeTime: row.endDate ?? null,
        updatedAt: row.updatedAt ?? null,
        fetchedAt,
        sourceUrl: `https://gamma-api.polymarket.com/markets/${row.id}`,
        priceBasis: "outcome_price",
      };
    } catch {
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    }
  }
  private async enrich(rows: PublicMarket[]) {
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.platform === "kalshi")
          .map((r) => r.eventId)
          .filter((id): id is string => !!id),
      ),
    ];
    // Four bounded workers; event lookup failure never changes market identity or invents context.
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (index < ids.length) {
          const id = ids[index++]!;
          const cached = this.events.get(id);
          if (cached && Date.now() - cached.at < 300000) continue;
          try {
            const payload = await this.read(
              new URL(
                `https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(id)}`,
              ),
            );
            const { event } = eventSchema.parse(payload);
            if (event.event_ticker !== id) continue;
            const value: EventPresentation = {
              mutuallyExclusive: event.mutually_exclusive ?? null,
              title: event.title,
              category: event.category ?? null,
              competition: event.product_metadata?.competition ?? null,
              marketScope: event.product_metadata?.competition_scope ?? null,
              imageUrl: null,
              marketImages: new Map(),
            };
            try {
              const artwork = eventArtworkSchema.parse(
                await this.read(
                  new URL(
                    `https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(id)}/metadata`,
                  ),
                ),
              );
              value.competition = artwork.competition ?? value.competition;
              value.marketScope =
                artwork.competition_scope ?? value.marketScope;
              value.imageUrl = trustedMarketImage(artwork.image_url);
              for (const item of artwork.market_details ?? [])
                value.marketImages.set(
                  item.market_ticker,
                  trustedMarketImage(item.image_url),
                );
            } catch {
              /* Optional artwork does not invalidate the verified event. */
            }
            if (this.events.size >= 200)
              this.events.delete(this.events.keys().next().value!);
            this.events.set(id, { at: Date.now(), value });
          } catch {
            /* Market remains available with an explicit native event ID. */
          }
        }
      }),
    );
    return rows.map((row) => {
      if (row.platform !== "kalshi" || !row.eventId) return row;
      const hit = this.events.get(row.eventId);
      if (!hit || Date.now() - hit.at >= 300000) return row;
      const e = hit.value;
      return {
        ...row,
        mutuallyExclusive: e.mutuallyExclusive,
        eventTitle: e.title,
        category: e.category,
        competition: e.competition,
        marketScope: e.marketScope,
        imageUrl: e.marketImages.get(row.id) ?? e.imageUrl,
      };
    });
  }
  async featuredSports() {
    const url = new URL("https://external-api.kalshi.com/trade-api/v2/events");
    url.searchParams.set("status", "open");
    url.searchParams.set("with_nested_markets", "true");
    url.searchParams.set("series_ticker", "KXNBAGAME");
    url.searchParams.set("limit", "6");
    const page = z
      .object({
        events: z
          .array(
            z.object({
              event_ticker: z.string(),
              series_ticker: z.literal("KXNBAGAME"),
              markets: z.array(z.unknown()).max(20),
            }),
          )
          .max(6),
      })
      .safeParse(await this.read(url));
    if (!page.success) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    const now = Date.now(),
      fetchedAt = new Date().toISOString();
    const rows = page.data.events.flatMap((event) =>
      event.markets
        .filter((value) => {
          const m = z
            .object({
              event_ticker: z.string(),
              status: z.string(),
              occurrence_datetime: time,
            })
            .safeParse(value);
          if (!m.success || m.data.event_ticker !== event.event_ticker)
            throw new CatalogError("INVALID_PROVIDER_RESPONSE");
          return (
            m.data.status === "active" &&
            !!m.data.occurrence_datetime &&
            Date.parse(m.data.occurrence_datetime) > now
          );
        })
        .map((value) => this.normalize(value, "kalshi", fetchedAt)),
    );
    return this.enrich(rows);
  }
  async list(platform: Platform, limit = 20, cursor?: string) {
    const normalized = cursorSchema.parse({
      platform,
      limit,
      native: "",
      offset: 0,
    });
    let state = normalized;
    if (cursor) {
      try {
        state = cursorSchema.parse(
          JSON.parse(
            Buffer.from(
              z.string().max(4096).parse(cursor),
              "base64url",
            ).toString("utf8"),
          ),
        );
      } catch {
        throw new CatalogError("INVALID_CURSOR");
      }
      if (state.platform !== platform || state.limit !== limit)
        throw new CatalogError("CURSOR_FILTER_MISMATCH");
    }
    const url = new URL(
      platform === "kalshi"
        ? "https://external-api.kalshi.com/trade-api/v2/events"
        : "https://gamma-api.polymarket.com/markets",
    );
    url.searchParams.set("limit", String(limit));
    if (platform === "kalshi") {
      url.searchParams.set("status", "open");
      url.searchParams.set("with_nested_markets", "true");
      if (state.native) url.searchParams.set("cursor", state.native);
    } else {
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("offset", String(state.offset));
    }
    const payload = await this.read(url);
    const fetchedAt = new Date().toISOString();
    let rows: unknown[];
    let next: typeof state | null;
    if (platform === "kalshi") {
      const page = z
        .object({
          events: z
            .array(
              z.object({
                event_ticker: z.string(),
                markets: z.array(z.unknown()).max(2000),
              }),
            )
            .max(40),
          cursor: z.string().max(2048).optional(),
        })
        .safeParse(payload);
      if (!page.success) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      rows = page.data.events.flatMap((event) =>
        event.markets.filter((market) => {
          const identity = z
            .object({ event_ticker: z.string(), status: z.string().optional() })
            .safeParse(market);
          if (
            !identity.success ||
            identity.data.event_ticker !== event.event_ticker
          )
            throw new CatalogError("INVALID_PROVIDER_RESPONSE");
          return (
            !identity.data.status ||
            ["active", "initialized"].includes(identity.data.status)
          );
        }),
      );
      if (rows.length > 2000)
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      next = page.data.cursor ? { ...state, native: page.data.cursor } : null;
    } else {
      const page = z.array(z.unknown()).safeParse(payload);
      if (!page.success) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      rows = page.data;
      next =
        rows.length === limit && state.offset + limit <= 10000
          ? { ...state, offset: state.offset + limit }
          : null;
    }
    return {
      data: await this.enrich(
        rows.map((row) => this.normalize(row, platform, fetchedAt)),
      ),
      fetchedAt,
      provider: `${platform}-public` as const,
      nextCursor: next
        ? Buffer.from(JSON.stringify(next)).toString("base64url")
        : null,
    };
  }
  async get(platform: Platform, id: string) {
    if (!marketReferenceSchema.safeParse({ platform, id }).success)
      throw new CatalogError("INVALID_MARKET_ID");
    const url = new URL(
      platform === "kalshi"
        ? `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(id)}`
        : "https://gamma-api.polymarket.com/markets",
    );
    if (platform === "polymarket") url.searchParams.set("condition_ids", id);
    const payload = await this.read(url);
    const fetchedAt = new Date().toISOString();
    const value =
      platform === "kalshi"
        ? z.object({ market: z.unknown() }).safeParse(payload)
        : z.array(z.unknown()).safeParse(payload);
    if (!value.success) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    const row = this.normalize(
      Array.isArray(value.data) ? value.data[0] : value.data.market,
      platform,
      fetchedAt,
    );
    if (row.id !== id) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return {
      data: await this.enrich([row]),
      fetchedAt,
      nextCursor: null,
      provider: `${platform}-public` as const,
    };
  }
}
