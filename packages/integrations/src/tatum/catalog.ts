import { createHash } from "node:crypto";
import { z } from "zod";

const platformSchema = z.enum(["polymarket", "kalshi"]);
export type Platform = z.infer<typeof platformSchema>;
export const marketReferenceSchema = z
  .object({ platform: platformSchema, id: z.string().min(1).max(128) })
  .strict()
  .refine(
    (value) =>
      value.platform === "polymarket"
        ? /^0x[a-fA-F0-9]{64}$/.test(value.id)
        : /^[A-Z][A-Z0-9_.-]{0,127}$/.test(value.id),
    "INVALID_MARKET_ID",
  );
const cursorSchema = z
  .object({
    value: z.string().min(1).max(1024),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const catalogQuerySchema = z
  .object({
    platform: platformSchema.optional(),
    status: z.enum(["active", "closed", "resolved"]).optional(),
    category: z.string().min(1).max(64).optional(),
    tag: z.string().min(1).max(64).optional(),
    search: z.string().min(1).max(256).optional(),
    eventId: z
      .string()
      .max(128)
      .regex(/^(\d+|[A-Z][A-Z0-9_.-]*)$/)
      .optional(),
    endingBefore: z.iso.datetime({ offset: true }).optional(),
    minVolume: z.number().finite().nonnegative().optional(),
    sort: z
      .enum(["volume_desc", "liquidity_desc", "endingSoon", "newest"])
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .refine(
    (q) =>
      q.platform === "polymarket" ||
      [q.status, q.category, q.tag, q.search, q.minVolume].every(
        (v) => v === undefined,
      ),
    "POLYMARKET_FILTER_REQUIRED",
  );

export class CatalogError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
const date = z.iso.datetime({ offset: true }).nullable();
const outcome = z.object({
  name: z.string().min(1),
  price: z.number().finite().min(0).max(1),
  tokenId: z.string().nullable(),
});
const source = z.object({
  platform: platformSchema,
  platformId: z.string().min(1),
  url: z.url(),
});
const resolution = z
  .object({
    outcome: z.string().min(1),
    resolvedAt: z.iso.datetime({ offset: true }),
    txHash: z.string().nullable(),
    source: z.string().nullable(),
  })
  .nullable();
export const rowSchema = z.object({
  id: z.string().min(1),
  platform: platformSchema,
  eventId: z.string().nullable(),
  question: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  imageUrl: z.string().nullable(),
  status: z.string().min(1),
  openTime: date,
  closeTime: date,
  settleTime: date,
  outcomes: z
    .array(outcome)
    .min(2)
    .refine((v) => new Set(v.map((o) => o.name)).size === v.length),
  volume: z.number().finite().nonnegative(),
  volumeUnit: z.enum(["usd", "contracts"]),
  liquidity: z.number().finite().nonnegative().nullable(),
  resolution,
  createdAt: date,
  source,
  chain: z.unknown(),
});
const listSchema = z.object({
  data: z.array(rowSchema),
  pagination: z.object({
    pageSize: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(1024).optional(),
  }),
});
const detailSchema = z.object({ data: rowSchema });
export type CatalogQuery = z.input<typeof catalogQuerySchema>;

function nativeId(platform: Platform, id: string) {
  return platform === "polymarket"
    ? /^0x[a-fA-F0-9]{64}$/.test(id)
    : /^[A-Z][A-Z0-9_.-]{0,127}$/.test(id);
}
function normalize(row: z.infer<typeof rowSchema>, fetchedAt: string) {
  const url = new URL(row.source.url);
  const allowed =
    row.platform === "polymarket"
      ? ["polymarket.com", "www.polymarket.com"]
      : ["kalshi.com", "www.kalshi.com"];
  if (
    !nativeId(row.platform, row.id) ||
    row.source.platform !== row.platform ||
    url.protocol !== "https:" ||
    !allowed.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    row.volumeUnit !== (row.platform === "kalshi" ? "contracts" : "usd") ||
    (row.platform === "kalshi" &&
      (row.liquidity !== null || row.chain !== null)) ||
    (row.resolution &&
      !row.outcomes.some((o) => o.name === row.resolution?.outcome))
  ) {
    throw new CatalogError("INVALID_PROVIDER_RESPONSE");
  }
  return {
    ...row,
    fetchedAt,
    priceAsOf: null,
    rules: row.description,
    rulesHash:
      row.description === null
        ? null
        : createHash("sha256").update(row.description).digest("hex"),
    coverage: "market_data_only" as const,
  };
}

/** Small REST adapter: the inspected official Tatum SDK lacks typed Prediction methods. */
export class TatumCatalog {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly beforeRequest?: (costCredits: number) => Promise<void>,
  ) {
    if (typeof window !== "undefined") throw new CatalogError("SERVER_ONLY");
    if (!apiKey.trim()) throw new CatalogError("TATUM_NOT_CONFIGURED");
  }
  private async request(
    path: string,
    query?: URLSearchParams,
  ): Promise<unknown> {
    const url = new URL(`https://api.tatum.io/v4/data/prediction/${path}`);
    if (query) url.search = query.toString();
    await this.beforeRequest?.(100);
    try {
      const response = await this.transport(url, {
        headers: { "x-api-key": this.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!response.ok) {
        const seconds = Number(response.headers.get("Retry-After"));
        throw new CatalogError(
          response.status === 429
            ? "PROVIDER_RATE_LIMITED"
            : response.status === 401 || response.status === 403
              ? "PROVIDER_ACCESS_DENIED"
              : response.status === 404
                ? "MARKET_NOT_FOUND"
                : "PROVIDER_UNAVAILABLE",
          response.status === 429 && Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, 3600)
            : undefined,
        );
      }
      // Bound provider payloads even when Content-Length is absent.
      const reader = response.body?.getReader();
      if (!reader) throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      let text = "";
      let bytes = 0;
      const decoder = new TextDecoder();
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
      throw new CatalogError("PROVIDER_UNAVAILABLE");
    }
  }
  async list(input: CatalogQuery) {
    const parsed = catalogQuerySchema.parse(input);
    const { cursor, ...filters } = parsed;
    const pairs = Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(pairs))
      .digest("hex");
    if (cursor && cursor.fingerprint !== fingerprint)
      throw new CatalogError("CURSOR_FILTER_MISMATCH");
    const query = new URLSearchParams(
      pairs.map(([key, value]) => [key, String(value)]),
    );
    if (cursor) query.set("cursor", cursor.value);
    const parsedResponse = listSchema.safeParse(
      await this.request("markets", query),
    );
    if (!parsedResponse.success)
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    const fetchedAt = new Date().toISOString();
    const data = parsedResponse.data.data.map((row) => {
      if (parsed.platform && row.platform !== parsed.platform)
        throw new CatalogError("INVALID_PROVIDER_RESPONSE");
      return normalize(row, fetchedAt);
    });
    return {
      data,
      fetchedAt,
      nextCursor: parsedResponse.data.pagination.cursor
        ? { value: parsedResponse.data.pagination.cursor, fingerprint }
        : null,
    };
  }
  async get(platform: Platform, id: string) {
    platformSchema.parse(platform);
    if (!nativeId(platform, id)) throw new CatalogError("INVALID_MARKET_ID");
    const result = detailSchema.safeParse(
      await this.request(`markets/${encodeURIComponent(id)}`),
    );
    if (
      !result.success ||
      result.data.data.platform !== platform ||
      result.data.data.id !== id
    )
      throw new CatalogError("INVALID_PROVIDER_RESPONSE");
    return { data: normalize(result.data.data, new Date().toISOString()) };
  }
}
