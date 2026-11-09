import { z } from "zod";
export const marketIdentitySchema = z
  .object({
    platform: z.enum(["polymarket", "kalshi"]),
    nativeId: z.string().trim().min(1),
  })
  .strict();
export type MarketIdentity = z.infer<typeof marketIdentitySchema>;
export function marketKey(value: MarketIdentity): string {
  const m = marketIdentitySchema.parse(value);
  return JSON.stringify([m.platform, m.nativeId]);
}
export const marketSnapshotSchema = z
  .object({
    market: marketIdentitySchema,
    eventId: z.string().nullable(),
    question: z.string().min(1),
    outcomes: z
      .array(z.string().min(1))
      .min(2)
      .refine((v) => new Set(v).size === v.length, "DUPLICATE_OUTCOMES"),
    rulesReference: z.url(),
    rulesHash: z.string().min(1),
    closeTime: z.iso.datetime().nullable(),
    fetchedAt: z.iso.datetime(),
    priceAsOf: z.iso.datetime().nullable(),
    nativeUnit: z.string().min(1),
  })
  .strict();
