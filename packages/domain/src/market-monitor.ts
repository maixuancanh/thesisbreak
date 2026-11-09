import { z } from "zod";
export const monitorCreateSchema = z
  .object({
    pickId: z.string().min(1).max(128),
    baseVersion: z.number().int().positive(),
    requestId: z.uuid(),
    confirmed: z.literal(true),
    durationHours: z.number().int().min(1).max(168),
    independentNews: z.boolean().default(false),
  })
  .strict();
export const marketObservationSchema = z
  .object({
    rules: z.string().max(20000).nullable(),
    prices: z
      .array(
        z.object({
          name: z.string().max(256),
          price: z.number().min(0).max(1).nullable(),
        }),
      )
      .min(2)
      .max(30),
    sourceUrl: z.url(),
    fetchedAt: z.iso.datetime({ offset: true }),
    resolution: z
      .object({
        outcome: z.string().min(1).max(256),
        resolvedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.resolution ||
      (v.prices.some((p) => p.name === v.resolution?.outcome) &&
        Date.parse(v.resolution.resolvedAt) <= Date.parse(v.fetchedAt)),
    "INVALID_RESOLUTION",
  );
export type MarketObservation = z.infer<typeof marketObservationSchema>;
export function compareMarketObservation(
  previous: MarketObservation,
  value: MarketObservation,
) {
  const old = marketObservationSchema.parse(previous),
    next = marketObservationSchema.parse(value);
  if (new URL(old.sourceUrl).origin !== new URL(next.sourceUrl).origin)
    throw new Error("SOURCE_CHANGED");
  if (Date.parse(next.fetchedAt) < Date.parse(old.fetchedAt))
    return { kind: "source_delayed", reasonChanged: false };
  if (next.resolution) {
    if (!old.resolution)
      return { kind: "market_resolved", reasonChanged: false };
    if (
      old.resolution.outcome !== next.resolution.outcome ||
      old.resolution.resolvedAt !== next.resolution.resolvedAt
    )
      return { kind: "resolution_corrected", reasonChanged: false };
    return { kind: "unchanged", reasonChanged: false };
  }
  if (old.resolution)
    return { kind: "source_incomplete", reasonChanged: false };
  if (!next.rules?.trim() || next.prices.every((p) => p.price === null))
    return { kind: "source_incomplete", reasonChanged: false };
  if (old.rules?.trim() !== next.rules.trim())
    return { kind: "rules_changed", reasonChanged: false };
  const sort = (v: MarketObservation) =>
    [...v.prices].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(sort(old)) !== JSON.stringify(sort(next)))
    return { kind: "price_changed", reasonChanged: false };
  return { kind: "unchanged", reasonChanged: false };
}
