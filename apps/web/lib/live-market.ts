import { z } from "zod";

export const livePlatform = z.enum(["polymarket", "kalshi"]);
export type LivePlatform = z.infer<typeof livePlatform>;
export const liveProvider = z.enum(["public", "tatum"]);
export type LiveProvider = z.infer<typeof liveProvider>;
export const liveMarketSchema = z.object({
  resolution: z
    .object({
      outcome: z.string(),
      resolvedAt: z.iso.datetime({ offset: true }),
    })
    .nullable()
    .optional(),
  id: z.string().min(1),
  platform: livePlatform,
  question: z.string().min(1),
  eventTitle: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  conditionLabel: z.string().nullable().optional(),
  mutuallyExclusive: z.boolean().nullable().optional(),
  competition: z.string().nullable().optional(),
  marketScope: z.string().nullable().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  imageUrl: z.url().nullable().optional(),
  outcomes: z.array(
    z.object({ name: z.string(), price: z.number().min(0).max(1).nullable() }),
  ),
  rules: z.string().nullable(),
  closeTime: z.string().nullable(),
  fetchedAt: z.string(),
  updatedAt: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  priceBasis: z.enum(["last_trade", "outcome_price", "unavailable"]).optional(),
});
export type LiveMarket = z.infer<typeof liveMarketSchema>;
export const livePageSchema = z.object({
  featuredSeries: z.string().nullable().optional(),
  data: z.array(liveMarketSchema),
  nextCursor: z.string().nullable(),
  provider: z.enum(["tatum", "polymarket-public", "kalshi-public"]),
  fetchedAt: z.string(),
});
export type LivePage = z.infer<typeof livePageSchema>;
export function liveMarketPath(
  m: Pick<LiveMarket, "id" | "platform">,
  provider?: LivePage["provider"],
) {
  const source = provider
    ? `?provider=${provider === "tatum" ? "tatum" : "public"}`
    : "";
  return `/live-market/${m.platform}/${encodeURIComponent(m.id)}${source}`;
}
export function outcomePrice(price: number | null) {
  return price === null
    ? "Price unavailable"
    : `${(price * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}¢`;
}
export async function fetchLivePage(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<LivePage> {
  const response = await fetch(`/api/live-markets?${query}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "This source is unavailable or unconfigured. Retry or choose another platform."
        : "Markets could not be loaded. Retry or choose another platform.",
    );
  }
  const result = livePageSchema.safeParse(await response.json());
  if (!result.success)
    throw new Error(
      "The source returned an unsupported market response. Retry or choose another platform.",
    );
  const platform = query.get("platform");
  if (result.data.data.some((m) => m.platform !== platform))
    throw new Error(
      "The source returned a different platform. Retry the request.",
    );
  const id = query.get("id");
  if (id && result.data.data.some((m) => m.id !== id))
    throw new Error(
      "The source returned a different market. Retry the request.",
    );
  return result.data;
}

export function friendlyDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(value));
}
export function providerLabel(value: LivePage["provider"]) {
  return value === "tatum"
    ? "Tatum"
    : value === "kalshi-public"
      ? "Kalshi public API"
      : "Polymarket public API";
}
export const pickDraftSchema = z
  .object({
    outcome: z.string().max(256),
    reason: z.string().max(4000),
    composer: z.string().max(4000),
  })
  .strict();
export function draftKey(
  platform: LivePlatform,
  id: string,
  provider: LiveProvider,
) {
  return `thesisbreak.live.v6:${JSON.stringify([platform, id, provider])}`;
}
export function readDraft(raw: string | null) {
  try {
    const value = pickDraftSchema.safeParse(JSON.parse(raw ?? "null"));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function pickPayload(
  platform: LivePlatform,
  nativeId: string,
  provider: LiveProvider,
  outcome: string,
  reason: string,
) {
  return { platform, nativeId, provider, outcome, reason: reason.trim() };
}
export function retryIdentity(
  previous: { payload: string; requestId: string } | null,
  payload: unknown,
  uuid: () => string,
) {
  const encoded = JSON.stringify(payload);
  return previous?.payload === encoded
    ? previous
    : { payload: encoded, requestId: uuid() };
}

export const pickReceiptSchema = z
  .object({
    userId: z.string().min(1).max(256),
    payload: z
      .object({
        platform: livePlatform,
        nativeId: z.string().min(1).max(128),
        provider: liveProvider,
        outcome: z.string().min(1).max(256),
        reason: z.string().max(4000),
      })
      .strict(),
    requestId: z.uuid(),
    saved: z.boolean(),
  })
  .strict();
export function readPickReceipt(
  raw: string | null,
  userId: string,
  payload: ReturnType<typeof pickPayload>,
) {
  try {
    const parsed = pickReceiptSchema.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success &&
      parsed.data.userId === userId &&
      JSON.stringify(parsed.data.payload) === JSON.stringify(payload)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
export function pickReceiptKey(key: string, userId: string) {
  return `${key}:request:${encodeURIComponent(userId)}`;
}

export const pickSaveResultSchema = z
  .object({ pickId: z.uuid(), version: z.number().int().positive() })
  .strict();
